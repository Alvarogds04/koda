'use strict';
/* N9 — packaging/install.sh behaviour, against a toy stage in temp dirs (never
   the real ~/.local/share). Run: node apps/desktop-tauri/test-node/install-check.cjs
   (also by cargo test via tests/install_script.rs).
   K2-02 T2 (S1): the Linux installer ships the bundled runtime as ONE verified
   archive (koda-runtime-linux-x64.tar.gz), needs NO Node on the machine, verifies
   the archive members before extracting, installs the extracted tree as
   PREFIX/runtime, and refuses symlink/absolute/.. members. */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
// install.sh is the LINUX installer (POSIX sh, absolute POSIX paths, ~/.local/share): it never runs on Windows, where
// paths are C:\... and the installer is NSIS. Its Windows twin is test-node/windows-runtime-check.cjs (the NSIS
// payload/runtime macros) plus ci/public/smoke-windows*.ps1 (the installed app). macOS ships a .app (macos-runtime-check).
if (process.platform === 'win32') {
  console.log('install-check: 0 passed — SKIPPED on Windows: install.sh is the Linux installer; its Windows twin is windows-runtime-check.cjs + the installed smokes');
  process.exit(0);
}
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../packaging/lib.cjs');
const SCRIPT = path.join(__dirname, '..', 'packaging', 'install.sh');
const ARCHIVE = 'koda-runtime-linux-x64.tar.gz';
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const zlib = require('node:zlib');
const T = require('./tmpdirs.cjs'); // self-cleaning: removed at exit, dead runs swept
const tmp = () => T.make('abito-inst-');
function receipt(st) {
  try { return JSON.parse(fs.readFileSync(path.join(st, 'receipt.json'), 'utf8')); }
  catch (error) { throw new Error(`invalid test receipt: ${error.message}`); }
}

/* A real (small) runtime archive, packed the way packaging/runtime/build-runtime.cjs
   packs it: members `./...` at the runtime root, `node` executable, no links. The
   extracted `node` is a sh shim that execs THIS test's Node and marks stderr, so a
   test can prove the bundled node (never a system Node) ran the verification. */
function runtimeArchive(outDir) {
  const root = path.join(T.make('koda-rt-src-'), 'rt');
  fs.mkdirSync(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node'), `#!/bin/sh\necho koda-runtime-node-ran >&2\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'pi'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'))} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'LICENSE.node'), 'Node licence\n');
  fs.writeFileSync(path.join(root, 'koda-runtime.json'), JSON.stringify({ target: 'linux-x64', node: '22.23.4', pi: '1.4.0', piCli: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js' }));
  fs.writeFileSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', bin: { pi: 'dist/bundle/cli.js' } }));
  fs.writeFileSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), "console.log('1.4.0');\n");
  const out = path.join(outDir, ARCHIVE);
  let r = cp.spawnSync('tar', ['-czf', out, '--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-C', root, '.'], { encoding: 'utf8' });
  if (r.status !== 0) r = cp.spawnSync('tar', ['-czf', out, '-C', root, '.'], { encoding: 'utf8' }); // bsdtar has no --sort
  assert.equal(r.status, 0, `tar failed: ${r.stderr}`);
  fs.chmodSync(out, 0o644); // tar follows the umask; the staged archive is 0644 like build.cjs stages it
  return out;
}

/* A minimal ustar writer for adversarial archives: members the real packer would
   never produce (symlinks, hardlinks, absolute paths, .. components). */
function craftedTarGz(out, members) {
  const blocks = [];
  for (const m of members) {
    const h = Buffer.alloc(512);
    h.write(m.name, 0, Math.min(m.name.length, 100), 'utf8');
    h.write(m.mode || '0000644', 100, 7, 'ascii');
    h.write('0000000', 108, 7, 'ascii'); // uid
    h.write('0000000', 116, 7, 'ascii'); // gid
    const size = m.data ? m.data.length : 0;
    h.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii');
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 11, 'ascii');
    h.write(m.type, 156);
    if (m.linkname) h.write(m.linkname, 157, Math.min(m.linkname.length, 100), 'utf8');
    h.write('ustar\0', 257); h.write('00', 263);
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    if (m.data) {
      blocks.push(m.data);
      const pad = (512 - (m.data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(out, zlib.gzipSync(Buffer.concat(blocks)));
}

function stage() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'abito-island'), '#!/bin/sh\necho toy binary\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island.png'), 'png-bytes', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  for (const n of L.DAEMON_FILES) {
    const file = path.join(dir, 'desktop-daemon', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'desktop-daemon', n), file);
    fs.chmodSync(file, 0o644);
  }
  for (const n of L.HARNESS_FILES) {
    const file = path.join(dir, 'desktop-harness', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'desktop-harness', n), file);
    fs.chmodSync(file, 0o644);
  }
  for (const name of L.PI_FILES) {
    const file = path.join(dir, 'desktop-pi', name); fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o755});
    fs.copyFileSync(path.join(__dirname, '..', '..', 'desktop-pi', name), file); fs.chmodSync(file, 0o644);
  }
  runtimeArchive(dir); // the bundled runtime archive is a staged file like any other (K2-02 T2)
  const files = {};
  for (const n of new Set([...L.STAGED, ARCHIVE])) files[n] = sha(fs.readFileSync(path.join(dir, n)));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ identifier: L.IDENTIFIER, version: '0.1.0', r6_sha256: L.checkR6(path.join(__dirname, '..')),
    provenance: { head: 'a'.repeat(40), clean: true, dirty_entries: 0 }, files }, null, 2) + '\n', { mode: 0o644 });
  return dir;
}
function env() {
  const home = tmp(); const root = path.join(home, 'project'); fs.mkdirSync(root);
  return { home, root, prefix: path.join(home, 'share', 'abito-island'), apps: path.join(home, 'share', 'applications') };
}
const run = (args, e) => cp.spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: e.home } });
const install = (st, e, extra = []) => run([st, '--prefix', e.prefix, '--applications-dir', e.apps, '--project-root', e.root, ...extra], e);
const tree = d => (fs.existsSync(d) ? fs.readdirSync(d).sort() : null);
const snapshot = e => JSON.stringify([tree(e.prefix), tree(e.apps)]);
/* The installer extracts into a private temp dir on the PREFIX filesystem
   (<prefix parent>/.runtime.*): a failed run must sweep them. */
const runtimeTempLeftovers = e => (fs.existsSync(path.dirname(e.prefix))
  ? fs.readdirSync(path.dirname(e.prefix)).filter(n => n.startsWith('.runtime.')) : []);
/* A PATH with exactly the tools install.sh needs and NO node anywhere (the Linux
   no-system-Node mechanism; the macOS/Windows installers have their own twins). */
function noNodeBin() {
  const bin = tmp();
  for (const t of ['tar', 'gzip', 'gunzip', 'sha256sum', 'shasum', 'cut', 'grep', 'sed', 'awk', 'wc', 'cp', 'mv', 'chmod', 'mkdir', 'rmdir', 'rm', 'dirname', 'basename', 'cat', 'ls', 'tr', 'head', 'env', 'id', 'od', 'expr']) {
    const p = fs.existsSync(`/usr/bin/${t}`) ? `/usr/bin/${t}` : `/bin/${t}`;
    if (fs.existsSync(p)) fs.symlinkSync(p, path.join(bin, t));
  }
  return bin;
}
const runNoNode = (args, e) => cp.spawnSync('/bin/sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: noNodeBin(), HOME: e.home } });
const installNoNode = (st, e) => runNoNode([st, '--prefix', e.prefix, '--applications-dir', e.apps, '--project-root', e.root], e);

test('syntax: POSIX sh parses (sh -n) and has no bashisms in the shebang', () => {
  assert.equal(cp.spawnSync('sh', ['-n', SCRIPT]).status, 0);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /^#!\/bin\/sh\n/);
});

test('happy path: installs binary+launcher+png(+template+receipt), executable, hashes printed, .desktop resolved with ABITO_PROJECT_ROOT', () => {
  const st = stage(), e = env();
  const r = install(st, e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const n of ['abito-island', 'abito-island-launcher']) assert.ok(fs.statSync(path.join(e.prefix, n)).mode & 0o100, `${n} executable`);
  for (const n of [...L.STAGED, 'receipt.json']) if (n !== ARCHIVE) assert.ok(fs.existsSync(path.join(e.prefix, n)), n);
  assert.equal(fs.existsSync(path.join(e.prefix, ARCHIVE)), false, 'the runtime archive itself is not installed');
  // the bundled runtime: exactly the archive's tree, extracted at PREFIX/runtime
  for (const n of ['node', 'pi', 'LICENSE.node', 'koda-runtime.json', 'node_modules/@earendil-works/pi-coding-agent/package.json', 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js']) {
    assert.ok(fs.existsSync(path.join(e.prefix, 'runtime', n)), `runtime/${n}`);
  }
  assert.ok(fs.statSync(path.join(e.prefix, 'runtime', 'node')).mode & 0o100, 'runtime/node executable');
  assert.ok(fs.statSync(path.join(e.prefix, 'runtime')).isDirectory() && !fs.lstatSync(path.join(e.prefix, 'runtime')).isSymbolicLink(), 'runtime is a real dir');
  assert.deepEqual(L.checkInstalledLayout(e.prefix), [], 'the installed layout accepts exactly runtime/ as the unenumerated dir');
  assert.match(r.stderr, /koda-runtime-node-ran/, 'the extracted runtime node ran the verification');
  const desk = fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8');
  assert.doesNotMatch(desk, /@INSTALL_DIR@/);
  assert.ok(desk.split('\n').includes(`Exec=env ABITO_PROJECT_ROOT=${e.root} "${e.prefix}/abito-island-launcher"`), desk);
  assert.ok(desk.split('\n').includes(`Icon=${e.prefix}/abito-island.png`), desk);
  assert.match(desk, /^StartupWMClass=Abito-island$/m);
  assert.match(r.stdout, new RegExp(sha(fs.readFileSync(path.join(st, 'abito-island')))));
  assert.match(r.stdout, /abito-island-launcher/); assert.match(r.stdout, /Abito \(Tauri\)/);
  // and the toy binary runs through the launcher
  const run2 = cp.spawnSync(path.join(e.prefix, 'abito-island-launcher'), [], { encoding: 'utf8', env: { PATH: process.env.PATH, ABITO_PROJECT_ROOT: e.root } });
  assert.match(run2.stdout, /toy binary/);
});

const RUNTIME_FILES = ['node', 'pi', 'LICENSE.node', 'koda-runtime.json', 'node_modules/@earendil-works/pi-coding-agent/package.json'];

test('S1 (Linux mechanism): with NO Node anywhere on PATH (env -i, sparse PATH of tool symlinks), install.sh installs; the bundled runtime node is what ran', () => {
  if (process.platform === 'win32') return; // Windows ships its own runtime installer twin
  const st = stage(), e = env();
  const r = installNoNode(st, e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stderr.includes('koda-runtime-node-ran'), 'the extracted runtime node ran the lib.cjs verification (its marker is on stderr)');
  for (const n of [...L.STAGED, 'receipt.json']) if (n !== ARCHIVE) assert.ok(fs.existsSync(path.join(e.prefix, n)), n);
  for (const n of RUNTIME_FILES) assert.ok(fs.existsSync(path.join(e.prefix, 'runtime', n)), `runtime/${n}`);
  assert.ok(fs.statSync(path.join(e.prefix, 'runtime', 'node')).mode & 0o100, 'runtime/node executable');
  assert.deepEqual(L.checkInstalledLayout(e.prefix), []);
  // the bundled Pi runs through the runtime's own node, no system Pi involved
  const pv = cp.spawnSync(path.join(e.prefix, 'runtime', 'pi'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: e.home } });
  assert.equal(pv.status, 0, pv.stderr);
  assert.equal(pv.stdout, '1.4.0\n');
});

test('a tampered runtime archive (one byte) is refused with the exact hash line — even with NO Node on PATH — and the prefix is untouched', () => {
  const line = st => {
    const arc = path.join(st, ARCHIVE);
    const bytes = fs.readFileSync(arc); bytes[100] ^= 0xff; fs.writeFileSync(arc, bytes);
    const want = receipt(st).files[ARCHIVE];
    const got = sha(fs.readFileSync(arc));
    return `install.sh: HASH MISMATCH for ${ARCHIVE} (receipt ${want}, file ${got}): nothing was installed\n`;
  };
  for (const [label, runIt] of [
    ['with node on PATH', install],
    ...(process.platform === 'win32' ? [] : [['with NO node on PATH', installNoNode]]),
  ]) {
    const st = stage(), e = env(); fs.mkdirSync(e.apps, { recursive: true });
    const before = snapshot(e);
    const expected = line(st);
    const r = runIt(st, e);
    assert.equal(r.status, 1, `${label}: must be refused`);
    assert.equal(r.stderr, expected, label);
    assert.equal(snapshot(e), before, `${label}: nothing created`);
    assert.equal(fs.existsSync(e.prefix), false, label);
    assert.deepEqual(runtimeTempLeftovers(e), [], `${label}: no runtime temp left`);
  }
});

test('adversarial runtime archives: symlink, absolute, «..» and hardlink members are each refused BEFORE extraction, with the hash check passing', () => {
  const cases = {
    // The refusal is on the member TYPE; the name is tar -tzf's, the same on GNU tar and bsdtar (no «-> target» suffix).
    'symlink member': { members: [{ name: './evil', type: '2', mode: '0000777', linkname: '/etc/passwd' }], die: 'install.sh: refusing runtime archive member «./evil»: not a regular file or directory (symlink/hardlink/device/fifo)\n' },
    'absolute member': { members: [{ name: '/absolute/evil', type: '0', data: Buffer.from('x') }], die: 'install.sh: refusing runtime archive member «/absolute/evil»: absolute member paths are not allowed\n' },
    '.. member': { members: [{ name: '../evil', type: '0', data: Buffer.from('x') }], die: 'install.sh: refusing runtime archive member «../evil»: «..» components are not allowed\n' },
    'hardlink member': { members: [{ name: './node', type: '0', data: Buffer.from('x') }, { name: './dup', type: '1', mode: '0000755', linkname: './node' }], die: 'install.sh: refusing runtime archive member «./dup»: not a regular file or directory (symlink/hardlink/device/fifo)\n' },
  };
  for (const [name, { members, die }] of Object.entries(cases)) {
    const st = stage(), e = env(); fs.mkdirSync(e.apps, { recursive: true });
    const arc = path.join(st, ARCHIVE);
    craftedTarGz(arc, members);
    const r0 = receipt(st); r0.files[ARCHIVE] = sha(fs.readFileSync(arc)); // the hash check passes; the member check must refuse
    fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r0, null, 2) + '\n');
    const before = snapshot(e);
    const r = install(st, e);
    assert.equal(r.status, 1, `${name}: must be refused`);
    assert.equal(r.stderr, die, name);
    assert.equal(snapshot(e), before, `${name}: nothing installed`);
    assert.equal(fs.existsSync(e.prefix), false, name);
    assert.deepEqual(runtimeTempLeftovers(e), [], `${name}: nothing extracted`);
  }
});

/* macOS bsdtar (CI 41733396427, macos-26): `tar -tv` prints EIGHT columns before the name (perms, links, owner, group,
   size, month, day, time), GNU tar five. A `tar` shim that rewrites GNU's -tv listing into bsdtar's shape (and passes
   every other call straight to the real tar) proves the member audit does not depend on one tar's column layout. */
function bsdtarShapedBin() {
  const bin = noNodeBin();
  const realTar = fs.existsSync('/usr/bin/tar') ? '/usr/bin/tar' : '/bin/tar';
  fs.rmSync(path.join(bin, 'tar'), { force: true });
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh
case "$1" in
  -tvzf|-tvf) "${realTar}" "$@" | awk '{ t = substr($1, 1, 1); n = $0; sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +/, "", n); split($2, o, "/");
      printf "%s  0 %s %s %8s Nov  3 23:24 %s\\n", $1, (o[1] == "" ? "root" : o[1]), (o[2] == "" ? "root" : o[2]), $3, n }' ;;
  *) exec "${realTar}" "$@" ;;
esac
`, { mode: 0o755 });
  return bin;
}
test('the runtime member audit works with bsdtar\'s -tv columns too (macOS tar), not only GNU tar\'s', () => {
  const st = stage(), e = env();
  const r = cp.spawnSync('/bin/sh', [SCRIPT, st, '--prefix', e.prefix, '--applications-dir', e.apps, '--project-root', e.root],
    { encoding: 'utf8', env: { PATH: bsdtarShapedBin(), HOME: e.home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(e.prefix, 'runtime', 'node')), 'the runtime was installed');
  // and the refusals still hold under that layout
  const bad = stage(), e2 = env(); fs.mkdirSync(e2.apps, { recursive: true });
  craftedTarGz(path.join(bad, ARCHIVE), [{ name: './evil', type: '2', mode: '0000777', linkname: '/etc/passwd' }]);
  const r0 = receipt(bad); r0.files[ARCHIVE] = sha(fs.readFileSync(path.join(bad, ARCHIVE)));
  fs.writeFileSync(path.join(bad, 'receipt.json'), JSON.stringify(r0, null, 2) + '\n');
  const refused = cp.spawnSync('/bin/sh', [SCRIPT, bad, '--prefix', e2.prefix, '--applications-dir', e2.apps, '--project-root', e2.root],
    { encoding: 'utf8', env: { PATH: bsdtarShapedBin(), HOME: e2.home } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^install\.sh: refusing runtime archive member «\.\/evil»: not a regular file or directory \(symlink\/hardlink\/device\/fifo\)\n$/);
  assert.equal(fs.existsSync(e2.prefix), false);
});

test('uninstall removes PREFIX/runtime when it is a real directory inside PREFIX, and leaves a PREFIX/runtime symlink alone', () => {
  const st = stage(), e = env();
  assert.equal(install(st, e).status, 0);
  const u = run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.existsSync(path.join(e.prefix, 'runtime')), false, 'runtime removed');
  assert.equal(fs.existsSync(path.join(e.prefix, ARCHIVE)), false);
  // a symlinked runtime is not ours to remove: leave it, never follow it
  const external = tmp(); // T.make already creates the directory
  assert.equal(install(st, e).status, 0);
  fs.rmSync(path.join(e.prefix, 'runtime'), { recursive: true });
  fs.symlinkSync(external, path.join(e.prefix, 'runtime'));
  const u2 = run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e);
  assert.equal(u2.status, 0, u2.stderr);
  assert.equal(fs.lstatSync(path.join(e.prefix, 'runtime')).isSymbolicLink(), true, 'the symlink was left alone');
  assert.deepEqual(fs.readdirSync(external), [], 'the symlink target was not touched');
});

test('reinstall refuses to replace a PREFIX/runtime that is a symlink or not a real directory', () => {
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  fs.rmSync(path.join(e.prefix, 'runtime'), { recursive: true });
  fs.symlinkSync(tmp(), path.join(e.prefix, 'runtime'));
  const link = fs.readlinkSync(path.join(e.prefix, 'runtime'));
  const r = install(st, e);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /runtime/);
  assert.equal(fs.readlinkSync(path.join(e.prefix, 'runtime')), link, 'the symlink survived');
  fs.rmSync(path.join(e.prefix, 'runtime'));
  fs.writeFileSync(path.join(e.prefix, 'runtime'), 'not a directory');
  const r2 = install(st, e);
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, /runtime/);
  assert.equal(fs.readFileSync(path.join(e.prefix, 'runtime'), 'utf8'), 'not a directory', 'the file survived');
});

test('the generated .desktop is valid for desktop-file-validate (when available)', () => {
  if (cp.spawnSync('sh', ['-c', 'command -v desktop-file-validate']).status !== 0) return;
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  const v = cp.spawnSync('desktop-file-validate', [path.join(e.apps, `${L.IDENTIFIER}.desktop`)], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test('VERIFY FIRST: any mismatch / missing / extra / bad receipt aborts and touches NOTHING', () => {
  const mutations = {
    'tampered daemon': st => fs.appendFileSync(path.join(st, 'desktop-daemon/src/cli.cjs'), '\n// tamper'),
    'extra daemon file': st => fs.writeFileSync(path.join(st, 'desktop-daemon/src/extra.cjs'), 'x'),
    'missing daemon file': st => fs.rmSync(path.join(st, 'desktop-daemon/src/cli.cjs')),
    'symlink daemon file': st => { fs.rmSync(path.join(st, 'desktop-daemon/src/cli.cjs')); fs.symlinkSync('/bin/true', path.join(st, 'desktop-daemon/src/cli.cjs')); },
    'symlink daemon directory': st => { fs.renameSync(path.join(st, 'desktop-daemon/src'), path.join(st, 'moved')); fs.symlinkSync('../moved', path.join(st, 'desktop-daemon/src')); },
    'extra empty directory': st => fs.mkdirSync(path.join(st, 'desktop-daemon/extra')),
    'extra receipt key': st => { const r = receipt(st); r.files['desktop-daemon/extra'] = 'a'.repeat(64); fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r, null, 2)); },
    'tampered binary': st => fs.appendFileSync(path.join(st, 'abito-island'), 'x'),
    'tampered launcher': st => fs.writeFileSync(path.join(st, 'abito-island-launcher'), '#!/bin/sh\nexec "$@"\n'),
    'tampered png': st => fs.writeFileSync(path.join(st, 'abito-island.png'), 'other'),
    'tampered desktop template': st => fs.appendFileSync(path.join(st, `${L.IDENTIFIER}.desktop`), 'Exec=evil\n'),
    'missing file': st => fs.rmSync(path.join(st, 'abito-island.png')),
    'extra file': st => fs.writeFileSync(path.join(st, 'surprise'), 'x'),
    'no receipt': st => fs.rmSync(path.join(st, 'receipt.json')),
    'receipt not clean': st => { const r = receipt(st); r.provenance.clean = false; fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r, null, 2)); },
    'receipt no head': st => { const r = receipt(st); delete r.provenance; fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r, null, 2)); },
    'foreign identifier': st => { const r = receipt(st); r.identifier = 'com.abitog.Abito.Preview'; fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r, null, 2)); },
    'hash of another file listed': st => { const r = receipt(st); r.files['abito-island'] = r.files['abito-island.png']; fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r, null, 2)); },
    'binary is a symlink': st => { fs.rmSync(path.join(st, 'abito-island')); fs.symlinkSync('/bin/true', path.join(st, 'abito-island')); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const st = stage(), e = env(); fs.mkdirSync(e.apps, { recursive: true });
    const before = snapshot(e); mutate(st);
    const r = install(st, e);
    assert.notEqual(r.status, 0, `${name} must abort`);
    assert.equal(snapshot(e), before, `${name}: nothing created`);
    assert.equal(fs.existsSync(e.prefix), false, `${name}: no install dir`);
    assert.deepEqual(runtimeTempLeftovers(e), [], `${name}: no runtime temp left`);
  }
});

test('installed directory symlink and extra files are refused without writing through them', () => {
  const st = stage(), e = env();
  assert.equal(install(st, e).status, 0);
  const external = tmp();
  fs.rmSync(path.join(e.prefix, 'desktop-daemon/src'), { recursive: true });
  fs.symlinkSync(external, path.join(e.prefix, 'desktop-daemon/src'));
  const r = install(st, e);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.equal(r.stdout, 'Stage verified against receipt.json (' + st + ').\n');
  assert.match(r.stderr, /symlink/);
  const other = env(); assert.equal(install(st, other).status, 0);
  fs.writeFileSync(path.join(other.prefix, 'desktop-daemon/extra'), 'keep');
  const before = fs.readFileSync(path.join(other.prefix, 'receipt.json'));
  const extra = install(st, other);
  assert.equal(extra.status, 1); assert.match(extra.stderr, /unexpected/);
  assert.deepEqual(fs.readFileSync(path.join(other.prefix, 'receipt.json')), before);
});

test('a failed verification on a REINSTALL leaves the previous install untouched', () => {
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  const before = sha(fs.readFileSync(path.join(e.prefix, 'abito-island')));
  fs.appendFileSync(path.join(st, 'abito-island'), 'tamper');
  assert.notEqual(install(st, e).status, 0);
  assert.equal(sha(fs.readFileSync(path.join(e.prefix, 'abito-island'))), before);
});

test('idempotent: reinstall over itself gives identical files, a fresh runtime/, and no temp leftovers', () => {
  const st = stage(), e = env();
  assert.equal(install(st, e).status, 0);
  const a = JSON.stringify(Object.fromEntries([...L.STAGED, 'receipt.json'].filter(n => n !== ARCHIVE).map(n => [n, sha(fs.readFileSync(path.join(e.prefix, n)))])));
  const deskA = fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8');
  const rtA = fs.readFileSync(path.join(e.prefix, 'runtime', 'node'));
  const r = install(st, e); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.stringify(Object.fromEntries([...L.STAGED, 'receipt.json'].filter(n => n !== ARCHIVE).map(n => [n, sha(fs.readFileSync(path.join(e.prefix, n)))]))), a);
  assert.equal(fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8'), deskA);
  assert.equal(fs.readFileSync(path.join(e.prefix, 'runtime', 'node')).equals(rtA), true, 'runtime replaced with the same bytes');
  assert.deepEqual(runtimeTempLeftovers(e), [], 'no .runtime.new/.runtime.old left behind');
  assert.deepEqual(L.checkInstalledLayout(e.prefix), []);
  // an installed prefix is no longer a stage (runtime/ replaced the archive): installing FROM it is refused
  const fromInstalled = install(e.prefix, e);
  assert.notEqual(fromInstalled.status, 0, 'the installed dir has no runtime archive to verify');
});

test('replaces a RUNNING binary (rename, not overwrite → no «text file busy»)', () => {
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  fs.writeFileSync(path.join(st, 'abito-island'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const r0 = receipt(st); r0.files['abito-island'] = sha(fs.readFileSync(path.join(st, 'abito-island')));
  fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r0, null, 2));
  const child = cp.spawn(path.join(e.prefix, 'abito-island'), { stdio: 'ignore' });
  try { assert.equal(install(st, e).status, 0); } finally { child.kill(); }
});

test('--uninstall removes exactly our files and the .desktop; foreign files and dirs stay', () => {
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  fs.writeFileSync(path.join(e.prefix, 'user-notes.txt'), 'keep');
  fs.writeFileSync(path.join(e.apps, 'other.desktop'), 'keep');
  const r = run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e);
  assert.equal(r.status, 0, r.stderr);
  for (const n of [...L.STAGED, 'receipt.json']) assert.equal(fs.existsSync(path.join(e.prefix, n)), false, n);
  assert.equal(fs.existsSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`)), false);
  assert.equal(fs.readFileSync(path.join(e.prefix, 'user-notes.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(e.apps, 'other.desktop'), 'utf8'), 'keep');
  // clean uninstall removes the (now empty) install dir; and uninstalling again is a no-op success
  fs.rmSync(path.join(e.prefix, 'user-notes.txt'));
  const again = run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e); assert.equal(again.status, 0);
  assert.equal(fs.existsSync(e.prefix), false);
  assert.equal(run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e).status, 0);
});

test('Koda 0.1: the launcher entry shows «Koda»; file, binary and icon names stay internal', () => {
  // Human 30-oct («Vamosa a cerrar esta version cambiar el nombre del repo por Koda y apartir de aqui empezaremos esta sera la version 0.1» → «Todo se llama Koda, repo nuevo desde 0.1» + «Solo lo visible»)
  const text = L.desktopText();
  assert.match(text, /^Name=Koda$/m); assert.match(text, /^Comment=Koda$/m);
  assert.match(text, /abito-island-launcher/); assert.match(text, /abito-island\.png/);
});

test('upgrading over a 0.1.2 install that holds its private audit/ log keeps the log and installs (29-oct, human Linux)', () => {
  const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
  const audit = path.join(e.prefix, 'audit');
  fs.mkdirSync(audit, { mode: 0o700 });
  const log = '{"ts":1,"event":"refused","code":"not_island","plan_hash":"x"}\n';
  fs.writeFileSync(path.join(audit, 'hook-installs.jsonl'), log, { mode: 0o600 });
  const r = install(st, e); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(audit, 'hook-installs.jsonl'), 'utf8'), log, 'the user audit record is kept byte for byte');
  assert.deepEqual(L.checkInstalledLayout(e.prefix).filter(p => !/audit/.test(p)), []);
  // uninstall leaves the user's audit records (and so the prefix) in place
  const u = run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e); assert.equal(u.status, 0, u.stderr);
  assert.equal(fs.readFileSync(path.join(audit, 'hook-installs.jsonl'), 'utf8'), log);
  assert.match(u.stdout, /Kept/);
});

test('an audit/ that is not a plain private folder of regular files is still refused', () => {
  const cases = {
    'audit is a symlink': p => fs.symlinkSync(tmp(), path.join(p, 'audit')),
    'audit holds a symlink': p => { fs.mkdirSync(path.join(p, 'audit'), { mode: 0o700 }); fs.symlinkSync('/etc/passwd', path.join(p, 'audit', 'x.jsonl')); },
    'audit holds a subfolder': p => { fs.mkdirSync(path.join(p, 'audit', 'sub'), { recursive: true, mode: 0o700 }); },
    'audit is world-readable': p => { fs.mkdirSync(path.join(p, 'audit'), { mode: 0o755 }); fs.chmodSync(path.join(p, 'audit'), 0o755); },
    'another unexpected dir': p => { fs.mkdirSync(path.join(p, 'logs'), { mode: 0o700 }); },
  };
  for (const [name, plant] of Object.entries(cases)) {
    const st = stage(), e = env(); assert.equal(install(st, e).status, 0);
    plant(e.prefix);
    const before = fs.readFileSync(path.join(e.prefix, 'receipt.json'));
    const r = install(st, e);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`); assert.match(r.stderr, /unsafe installed layout/, name);
    assert.deepEqual(fs.readFileSync(path.join(e.prefix, 'receipt.json')), before, name);
  }
});

test('uninstall → install round trip restores a verifying install', () => {
  const st = stage(), e = env();
  assert.equal(install(st, e).status, 0);
  assert.equal(run(['--uninstall', '--prefix', e.prefix, '--applications-dir', e.apps], e).status, 0);
  assert.equal(install(st, e).status, 0);
  assert.deepEqual(L.checkInstalledLayout(e.prefix), []);
  assert.ok(fs.existsSync(path.join(e.prefix, 'runtime', 'node')));
});

test('unsafe or colliding inputs are refused before anything is touched', () => {
  const st = stage();
  const bad = [
    ['relative prefix', () => ['--prefix', 'relative/dir']],
    ['prefix with space', e => ['--prefix', path.join(e.home, 'a b')]],
    ['prefix with quote', e => ['--prefix', path.join(e.home, 'a"b')]],
    ['prefix with percent', e => ['--prefix', path.join(e.home, 'a%b')]],
    ['prefix with dotdot', e => ['--prefix', `${e.home}/x/../y`]],
    ['prefix is /', () => ['--prefix', '/']],
    ['prefix is the Preview root', e => ['--prefix', path.join(e.home, 'share', 'com.abitog.Abito.Preview')]],
    ['prefix is the stage itself while a stranger lives there', e => ['--prefix', e.home, '--project-root', '/nonexistent/dir']],
    ['project root missing', e => ['--project-root', path.join(e.home, 'nope')]],
    ['project root relative', () => ['--project-root', 'rel']],
    ['project root with space', e => ['--project-root', path.join(e.home, 'x y')]],
    ['unknown flag', () => ['--bogus']],
  ];
  for (const [name, mk] of bad) {
    const e = env(); fs.mkdirSync(path.join(e.home, 'x y'), { recursive: true });
    const before = snapshot(e);
    const r = run([st, '--prefix', e.prefix, '--applications-dir', e.apps, '--project-root', e.root, ...mk(e)], e);
    assert.notEqual(r.status, 0, name);
    assert.equal(snapshot(e), before, `${name}: nothing touched`);
  }
});

test('defaults are documented: --help names the default prefix and says the project root is required; usage on no stage', () => {
  const e = env();
  const help = run(['--help'], e); assert.equal(help.status, 0);
  assert.match(help.stdout, /\.local\/share\/abito-island/);
  // public release (abito-release): no one else's checkout is a default — the project root is asked for
  assert.match(help.stdout, /--project-root DIR\s+\(required\)/); assert.doesNotMatch(help.stdout, /sb-second-brain/);
  assert.match(help.stdout, /--uninstall/); assert.match(help.stdout, /--prefix/); assert.match(help.stdout, /--project-root/);
  assert.notEqual(run([], e).status, 0);
});

test('public release: without --project-root nothing is installed and the error names the flag', () => {
  const e = env(); const st = stage();
  const before = snapshot(e);
  const r = run([st, '--prefix', e.prefix, '--applications-dir', e.apps], e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--project-root/);
  assert.equal(snapshot(e), before, 'nothing touched');
});

console.log(`install-check: ${passed} passed`);

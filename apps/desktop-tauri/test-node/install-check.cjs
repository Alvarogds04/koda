'use strict';
/* N9 — packaging/install.sh behaviour, against a toy stage in temp dirs (never
   the real ~/.local/share). Run: node apps/desktop-tauri/test-node/install-check.cjs
   (also by cargo test via tests/install_script.rs). */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../packaging/lib.cjs');
const SCRIPT = path.join(__dirname, '..', 'packaging', 'install.sh');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const T = require('./tmpdirs.cjs'); // self-cleaning: removed at exit, dead runs swept
const tmp = () => T.make('abito-inst-');
function receipt(st) {
  try { return JSON.parse(fs.readFileSync(path.join(st, 'receipt.json'), 'utf8')); }
  catch (error) { throw new Error(`invalid test receipt: ${error.message}`); }
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
  const files = {};
  for (const n of L.STAGED) files[n] = sha(fs.readFileSync(path.join(dir, n)));
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
const snapshot = e => JSON.stringify([tree(e.prefix), tree(e.apps), tree(path.dirname(e.prefix))]);

test('syntax: POSIX sh parses (sh -n) and has no bashisms in the shebang', () => {
  assert.equal(cp.spawnSync('sh', ['-n', SCRIPT]).status, 0);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /^#!\/bin\/sh\n/);
});

test('happy path: installs binary+launcher+png(+template+receipt), executable, hashes printed, .desktop resolved with ABITO_PROJECT_ROOT', () => {
  const st = stage(), e = env();
  const r = install(st, e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const n of ['abito-island', 'abito-island-launcher']) assert.ok(fs.statSync(path.join(e.prefix, n)).mode & 0o100, `${n} executable`);
  for (const n of [...L.STAGED, 'receipt.json']) assert.ok(fs.existsSync(path.join(e.prefix, n)), n);
  const desk = fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8');
  assert.doesNotMatch(desk, /@INSTALL_DIR@/);
  assert.ok(desk.split('\n').includes(`Exec=env ABITO_PROJECT_ROOT=${e.root} "${e.prefix}/abito-island-launcher"`), desk);
  assert.ok(desk.split('\n').includes(`Icon=${e.prefix}/abito-island.png`), desk);
  assert.match(desk, /^StartupWMClass=Abito-island$/m);
  assert.match(r.stdout, new RegExp(sha(fs.readFileSync(path.join(st, 'abito-island')))));
  assert.match(r.stdout, /abito-island-launcher/); assert.match(r.stdout, /Abito \(Tauri\)/);
  // the installed copy still verifies with the node verifier
  assert.deepEqual(L.verifyStage(e.prefix), []);
  // and the toy binary runs through the launcher
  const run2 = cp.spawnSync(path.join(e.prefix, 'abito-island-launcher'), [], { encoding: 'utf8', env: { PATH: process.env.PATH, ABITO_PROJECT_ROOT: e.root } });
  assert.match(run2.stdout, /toy binary/);
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

test('idempotent: reinstall over itself gives identical files and no errors', () => {
  const st = stage(), e = env();
  assert.equal(install(st, e).status, 0);
  const a = JSON.stringify(Object.fromEntries([...L.STAGED, 'receipt.json'].map(n => [n, sha(fs.readFileSync(path.join(e.prefix, n)))])));
  const deskA = fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8');
  const r = install(st, e); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.stringify(Object.fromEntries([...L.STAGED, 'receipt.json'].map(n => [n, sha(fs.readFileSync(path.join(e.prefix, n)))]))), a);
  assert.equal(fs.readFileSync(path.join(e.apps, `${L.IDENTIFIER}.desktop`), 'utf8'), deskA);
  // installing FROM the installed copy works too (stage = prefix)
  assert.equal(install(e.prefix, e).status, 0, 'reinstall from the installed dir');
  assert.deepEqual(L.verifyStage(e.prefix), []);
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
  assert.deepEqual(L.verifyStage(e.prefix).filter(p => !/audit/.test(p)), []);
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
  assert.deepEqual(L.verifyStage(e.prefix), []);
});

test('unsafe or colliding inputs are refused before anything is touched', () => {
  const st = stage();
  const bad = [
    ['relative prefix', e => ['--prefix', 'relative/dir']],
    ['prefix with space', e => ['--prefix', path.join(e.home, 'a b')]],
    ['prefix with quote', e => ['--prefix', path.join(e.home, 'a"b')]],
    ['prefix with percent', e => ['--prefix', path.join(e.home, 'a%b')]],
    ['prefix with dotdot', e => ['--prefix', `${e.home}/x/../y`]],
    ['prefix is /', e => ['--prefix', '/']],
    ['prefix is the Preview root', e => ['--prefix', path.join(e.home, 'share', 'com.abitog.Abito.Preview')]],
    ['prefix is the stage itself while a stranger lives there', e => ['--prefix', e.home, '--project-root', '/nonexistent/dir']],
    ['project root missing', e => ['--project-root', path.join(e.home, 'nope')]],
    ['project root relative', e => ['--project-root', 'rel']],
    ['project root with space', e => ['--project-root', path.join(e.home, 'x y')]],
    ['unknown flag', e => ['--bogus']],
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

'use strict';
/* M4 format A: checks for packaging/lib.cjs without building or launching
   anything (a fake stage dir). Run: node apps/desktop-tauri/test-node/packaging-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../packaging/lib.cjs');
for (const f of ['desktop-highlight.html', 'desktop-highlight.css']) {
  assert.ok(L.FRONTEND_FILES.includes(f), `highlight ships: ${f}`);
}
const highlight = fs.readFileSync(path.join(__dirname, '../frontend/desktop-highlight.html'), 'utf8');
assert.ok(!/<script|\bon\w+=|style=/i.test(highlight), 'highlight has no JS, IPC or inline style');
assert.ok(highlight.includes('desktop-highlight.css'));
const capabilities = JSON.parse(fs.readFileSync(path.join(__dirname, '../capabilities/main.json'), 'utf8'));
assert.ok(!capabilities.windows.includes('character-highlight'), 'no highlight capabilities');
const T = require('./tmpdirs.cjs'); // self-cleaning temp dirs
// a malformed fixture must fail the test with the file named, not with a bare SyntaxError
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read JSON ${file}: ${e.message}`); }
}
const crate = path.resolve(__dirname, '..');
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

function vendorFixture() {
  const dir = copyCrate();
  fs.cpSync(path.join(crate, 'frontend/vendor'), path.join(dir, 'frontend/vendor'), { recursive: true });
  return dir;
}
test('curated gate names an extra file nested under vendor/coucou', () => {
  const d = vendorFixture();
  fs.writeFileSync(path.join(d, 'frontend/vendor/coucou/settings/extra.js'), '1');
  assert.throws(() => L.checkFrontend(d), /extra=\[vendor\/coucou\/settings\/extra\.js\]/);
});
test('curated gate names a missing nested file', () => {
  const d = vendorFixture();
  fs.unlinkSync(path.join(d, 'frontend/vendor/coucou/settings/colors.js'));
  assert.throws(() => L.checkFrontend(d), /missing=\[vendor\/coucou\/settings\/colors\.js\]/);
});
test('K2-02 T2: the stage carries the runtime archive; the installed layout tolerates exactly a real runtime/ dir, never a link or a file', () => {
  const d = fakeStage();
  assert.deepEqual(L.verifyStage(d, { sourceCrate: crate }), []);
  // installed form: the archive is replaced by the extracted runtime/ tree (not enumerated)
  fs.rmSync(path.join(d, L.RUNTIME_ARCHIVE));
  fs.mkdirSync(path.join(d, 'runtime'), { mode: 0o700 });
  fs.writeFileSync(path.join(d, 'runtime/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'runtime/pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(L.checkInstalledLayout(d), [], 'runtime/ (real dir) is the one allowed unenumerated directory');
  fs.rmSync(path.join(d, 'runtime'), { recursive: true, force: true });
  fs.symlinkSync('/etc', path.join(d, 'runtime'));
  assert.match(L.checkInstalledLayout(d).join(), /runtime is a symlink/);
  fs.rmSync(path.join(d, 'runtime'), { force: true });
  fs.writeFileSync(path.join(d, 'runtime'), 'not a directory');
  assert.match(L.checkInstalledLayout(d).join(), /runtime is not a directory/);
  fs.rmSync(path.join(d, 'runtime'), { force: true });
  fs.mkdirSync(path.join(d, 'runtime'), { mode: 0o700 });
  fs.writeFileSync(path.join(d, 'runtime/node'), 'x', { mode: 0o700 });
  // runtime/ contents are NOT enumerated at all (decision A): their integrity comes
  // from the hash-verified archive, so an extra file inside runtime/ is not flagged.
  fs.writeFileSync(path.join(d, 'runtime/whatever'), 'x');
  assert.deepEqual(L.checkInstalledLayout(d), [], 'runtime/ contents are not enumerated');
});

function buildFixture() {
  const arcDir = T.make('koda-arc-');
  const archive = path.join(arcDir, 'koda-runtime-linux-x64.tar.gz');
  fs.writeFileSync(archive, 'runtime archive bytes\n');
  return archive;
}
function runBuild(argv) {
  const vm = require('node:vm');
  let receipt; let code = null; let err = '';
  const fakeFs = { ...fs, existsSync: () => true, mkdirSync() {}, rmSync() {}, copyFileSync() {}, chmodSync() {},
    writeFileSync(file, text) { if (file.endsWith('receipt.json')) receipt = JSON.parse(text); } };
  const fakeLib = { ...L, requireClean: () => ({ head: 'a'.repeat(40), clean: true }), verifyStage: () => [],
    sha256File: file => file.includes(`${path.sep}frontend${path.sep}`) ? L.sha256File(file) : 'stub' };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(crate, 'packaging/build.cjs'), 'utf8'), {
      __dirname: path.join(crate, 'packaging'), console: { log() {}, error(m) { err += `${m}\n`; } },
      process: { argv: ['node', 'build.cjs', ...argv], env: {}, exit(c) { code = c; throw new Error(`__exit__${c}`); } },
      require: name => name === 'node:fs' ? fakeFs : name === './lib.cjs' ? fakeLib
        : name === 'node:child_process' ? { spawnSync: () => ({ stdout: 'stub' }) } : require(name),
    });
  } catch (e) { if (!/^__exit__/.test(String(e.message))) throw e; }
  return { code, err, receipt };
}

test('build receipt hashes every curated path, including nested vendor files, and the runtime archive is staged + hashed like every file', () => {
  const receipt = runBuild(['--skip-cargo', '--runtime-archive', buildFixture()]).receipt;
  assert.ok(receipt, 'the build ran to completion and wrote a receipt');
  assert.equal(receipt.files['koda-runtime-linux-x64.tar.gz'], 'stub', 'the runtime archive is in the receipt files map (K2-02 T2)');
  for (const nested of ['vendor/coucou/settings/colors.js', 'settings.html', 'settings-app.js',
    'vendor/coucou/hub/shell.js', 'vendor/coucou/hub/ui.js', 'vendor/coucou/hub/general.js',
    'vendor/coucou/hub/hub.css', 'vendor/coucou/hub/abito.css',
    'vendor/coucou/hub/accounts.ts', 'vendor/coucou/hub/accounts.js',
    'vendor/coucou/hub/personalization.ts', 'vendor/coucou/hub/personalization.js',
    'vendor/coucou/hub/runtime.ts', 'vendor/coucou/hub/runtime.js',
    'vendor/coucou/hub/pages.ts', 'vendor/coucou/hub/pages.js',
    'vendor/coucou/hub/dictation-pages.ts', 'vendor/coucou/hub/dictation-pages.js',
    'vendor/coucou/hub/data-pages.ts', 'vendor/coucou/hub/data-pages.js', 'vendor/coucou/hub/keyaccounts.ts', 'vendor/coucou/hub/keyaccounts.js', 'vendor/coucou/hub/voice-page.ts', 'vendor/coucou/hub/voice-page.js', 'vendor/coucou/hub/privacy-page.js',
    'vendor/coucou/hub/notch.ts', 'vendor/coucou/hub/notch.js',
    'vendor/coucou/hub/agents.ts', 'vendor/coucou/hub/agents.js',
    'vendor/coucou/hub/chat.ts', 'vendor/coucou/hub/chat.js',
    'vendor/coucou/hub/integrations.ts', 'vendor/coucou/hub/integrations.js',
    'vendor/coucou/hub/shortcuts.ts', 'vendor/coucou/hub/shortcuts.js',
    'vendor/coucou/settings/colors.ts', 'vendor/coucou/hub/i18n-es.ts', 'clay-engine.js']) {
    assert.equal(receipt.inputs.frontend[nested], L.sha256File(path.join(crate, 'frontend', nested)));
  }
  assert.deepEqual(Object.keys(receipt.inputs.frontend).sort(), [...L.FRONTEND_FILES].sort());
});

test('build.cjs: --runtime-archive is required; a wrong name or a missing file is refused before anything is staged', () => {
  let r = runBuild(['--skip-cargo']);
  assert.equal(r.code, 2, r.err);
  assert.equal(r.err, 'build.cjs: --runtime-archive <file> is required: the installer ships the runtime as ONE verified archive (run packaging/runtime/build-runtime.cjs --archive first)\n');
  const wrong = path.join(T.make('koda-arc-'), 'wrong-name.tar.gz');
  fs.writeFileSync(wrong, 'x');
  r = runBuild(['--skip-cargo', '--runtime-archive', wrong]);
  assert.equal(r.code, 1, r.err);
  assert.equal(r.err, 'build.cjs: the runtime archive must be named koda-runtime-linux-x64.tar.gz, got wrong-name.tar.gz\n');
  r = runBuild(['--skip-cargo', '--runtime-archive', path.join(T.make('koda-arc-'), 'koda-runtime-linux-x64.tar.gz')]); // correctly named but absent
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /not a regular file/);
  assert.equal(r.receipt, undefined, 'no receipt was written');
});

test('source gates pass on the real crate (R6 pin, curated frontend, config, capabilities, no devtools)', () => {
  assert.ok(L.checkR6(crate).startsWith('40625d7f'));
  assert.equal(L.checkFrontend(crate).length, L.FRONTEND_FILES.length);
  const cfg = L.checkConfig(crate);
  assert.equal(cfg.identifier, 'com.abitog.AbitoTauri');
});

test('R7 character controller is explicitly in the closed shipped list', () => {
  assert.equal(L.FRONTEND_FILES.filter(f => f === 'character-motion.js').length, 1);
});

test('mini-bot module is explicitly in the closed shipped list', () => {
  assert.equal(L.FRONTEND_FILES.filter(f => f === 'character-minibots.js').length, 1);
});

test('F025 adds exactly its two assets to the closed shipped list', () => {
  assert.deepEqual(L.FRONTEND_FILES.filter(f => f.startsWith('chat-markdown.')).sort(), ['chat-markdown.css', 'chat-markdown.js']);
  assert.equal(new Set(L.FRONTEND_FILES).size, L.FRONTEND_FILES.length);
});

test('F031 pure catalog/model files are shipped without weakening the curated gate', () => {
  for (const file of ['pill-catalog.js', 'pill-settings.js', 'pills.js', 'pills-view.js']) assert.ok(L.FRONTEND_FILES.includes(file), file);
});

function copyCrate() {
  const dir = T.make('abito-pkg-');
  for (const f of ['tauri.conf.json', 'Cargo.toml']) fs.copyFileSync(path.join(crate, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'capabilities')); fs.copyFileSync(path.join(crate, 'capabilities', 'main.json'), path.join(dir, 'capabilities', 'main.json'));
  fs.mkdirSync(path.join(dir, 'frontend'));
  for (const f of L.FRONTEND_FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, 'frontend', f)), { recursive: true });
    fs.copyFileSync(path.join(crate, 'frontend', f), path.join(dir, 'frontend', f));
  }
  return dir;
}
test('each gate FAILS when its rule is broken', () => {
  const edit = (rel, fn, expect) => {
    const d = copyCrate();
    const p = path.join(d, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
    assert.throws(() => (rel.startsWith('frontend') && rel.endsWith('clay-engine.js') ? L.checkR6(d) : L.checkConfig(d)), expect, rel);
    fs.rmSync(d, { recursive: true });
  };
  edit('frontend/clay-engine.js', s => s + '\n// tweak', /R6 pin/);
  edit('tauri.conf.json', s => s.replace("default-src 'self'", "default-src 'self' https://evil.example"), /CSP/);
  edit('tauri.conf.json', s => s.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), /CSP/);
  edit('tauri.conf.json', s => s.replace('com.abitog.AbitoTauri', 'com.abitog.Abito.Preview'), /identifier/);
  edit('capabilities/main.json', s => s.replace('"core:event:allow-unlisten"', '"core:event:allow-unlisten", "core:window:allow-close"'), /capabilities drifted/);
  edit('capabilities/main.json', s => s.replace('"windows": ["main", "settings"]', '"windows": ["main", "settings", "evil"]'), /capability windows/);
  edit('capabilities/main.json', s => s.replace('"windows": ["main", "settings"]', '"windows": ["main"]'), /capability windows/);
  // #315: the closed tauri line now carries "tray-icon"; the gate under test
  // (devtools must stay off) is proven against the current template.
  edit('Cargo.toml', s => s.replace('tauri = { version = "2", features = ["tray-icon"] }', 'tauri = { version = "2", features = ["tray-icon", "devtools"] }'), /devtools/);
  const d = copyCrate(); fs.writeFileSync(path.join(d, 'frontend', 'extra.js'), '1');
  assert.throws(() => L.checkFrontend(d), /curated list/); fs.rmSync(d, { recursive: true });
});

function fakeStage({ crateDir: _crateDir = crate } = {}) {
  const dir = T.make('abito-stage-');
  fs.writeFileSync(path.join(dir, 'abito-island'), '#!/bin/true\nfake binary\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'abito-island.png'), 'png', { mode: 0o644 });
  for (const n of L.DAEMON_FILES) {
    const file = path.join(dir, 'desktop-daemon', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '..', 'desktop-daemon', n), file);
    fs.chmodSync(file, 0o644);
  }
  for (const n of L.HARNESS_FILES) {
    const file = path.join(dir, 'desktop-harness', n);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '..', 'desktop-harness', n), file);
    fs.chmodSync(file, 0o644);
  }
  for (const name of L.PI_FILES) {
    const file = path.join(dir, 'desktop-pi', name); fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o755});
    fs.copyFileSync(path.join(__dirname, '..', '..', 'desktop-pi', name), file); fs.chmodSync(file, 0o644);
  }
  // K2-02 T2: the runtime archive is a staged file like any other (verifyStage hashes it; only
  // install.sh parses it, which install-check covers with a real tar.gz).
  fs.writeFileSync(path.join(dir, 'koda-runtime-linux-x64.tar.gz'), 'runtime archive bytes (lib-level fixture)\n', { mode: 0o644 });
  const files = {};
  for (const n of L.STAGED) files[n] = L.sha256File(path.join(dir, n));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ identifier: L.IDENTIFIER, r6_sha256: L.checkR6(crate), provenance: { head: 'a'.repeat(40), clean: true }, files }), { mode: 0o644 });
  return dir;
}
test('L42 F1: the package ships the hook installer and everything it requires, and the staged daemon resolves it', () => {
  assert(Array.isArray(L.HARNESS_FILES) && L.HARNESS_FILES.includes('bin/abito-hook.cjs'), 'the installer is a shipped file');
  assert(L.HARNESS_FILES.includes('src/installer-platform.cjs'), 'platform guard must ship');
  assert(L.PI_FILES?.includes('pi-extension.ts'), 'closed Pi runtime payload must ship beside harness');
  // closed under require(): every relative require of a shipped harness file is shipped too
  for (const rel of L.HARNESS_FILES.filter(f => f.endsWith('.cjs'))) {
    const src = fs.readFileSync(path.join(crate, '..', 'desktop-harness', rel), 'utf8');
    for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      const sharedProbe = rel === 'src/installer-platform.cjs' && target === '../desktop-daemon/src/procinfo.cjs' && L.DAEMON_FILES.includes('src/procinfo.cjs');
      assert(sharedProbe || L.HARNESS_FILES.includes(target), `${rel} requires ${m[1]} (${target}) which is not shipped`);
    }
  }
  assert(L.STAGED.includes('desktop-harness/bin/abito-hook.cjs'));
  assert(L.STAGED_DIRS.includes('desktop-harness') && L.STAGED_DIRS.includes('desktop-harness/bin') && L.STAGED_DIRS.includes('desktop-harness/src'));
  const d = fakeStage();
  const { packagedInstallerBin } = require(path.join(d, 'desktop-daemon/src/cli.cjs'));
  assert.equal(packagedInstallerBin(path.join(d, 'desktop-daemon/src')), path.join(d, 'desktop-harness/bin/abito-hook.cjs'), 'the staged daemon finds the staged installer');
  assert.deepEqual(L.verifyStage(d, { sourceCrate: crate }), []);
  fs.rmSync(path.join(d, 'desktop-harness/src/install-ui.cjs'));
  assert(L.verifyStage(d, { sourceCrate: crate }).length > 0, 'a missing harness file fails verification');
});
test('HU-015: the daemon-free Agentes entry ships, closed under require(), beside the harness it drives', () => {
  assert(L.DAEMON_FILES.includes('src/agents-direct.cjs'), 'Ajustes → Agentes runs src/agents-direct.cjs with no daemon: it must be packaged');
  assert(L.STAGED.includes('desktop-daemon/src/agents-direct.cjs'));
  for (const rel of ['src/agents-direct.cjs', 'src/agents.cjs', 'src/agent-hooks.cjs']) {
    const src = fs.readFileSync(path.join(crate, '..', 'desktop-daemon', rel), 'utf8');
    for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      // HU-047: the daemon reaches the sibling harness package of the same stage (desktop-daemon/ and desktop-harness/
      // are siblings), so a ../desktop-harness/<file> target is shipped when it is in HARNESS_FILES.
      const sibling = target.startsWith('../desktop-harness/') && L.HARNESS_FILES.includes(target.slice('../desktop-harness/'.length));
      assert(L.DAEMON_FILES.includes(target) || sibling, `${rel} requires ${m[1]} (${target}) which is not shipped`);
    }
  }
  const d = fakeStage();
  assert.deepEqual(L.verifyStage(d, { sourceCrate: crate }), []);
  fs.rmSync(path.join(d, 'desktop-daemon/src/agents-direct.cjs'));
  assert(L.verifyStage(d, { sourceCrate: crate }).length > 0, 'a package without the entry fails verification');
});
test('verify: a pristine stage passes; tampering is caught without launching anything', () => {
  const d = fakeStage();
  assert.deepEqual(L.verifyStage(d, { sourceCrate: crate }), []);
  fs.appendFileSync(path.join(d, 'abito-island'), 'x');
  assert.match(L.verifyStage(d).join(), /abito-island hash differs/);
  fs.rmSync(d, { recursive: true });
  const e = fakeStage();
  fs.writeFileSync(path.join(e, 'abito-island-launcher'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  assert.match(L.verifyStage(e).join(), /launcher/);
  fs.writeFileSync(path.join(e, 'extra'), 'x');
  assert.match(L.verifyStage(e).join(), /unexpected stage entries/);
  fs.rmSync(e, { recursive: true });
  const w = fakeStage(); fs.chmodSync(path.join(w, 'abito-island'), 0o777);
  assert.match(L.verifyStage(w).join(), /writable/);
  fs.rmSync(w, { recursive: true });
});
// K2-02 (windows-latest, K2-01b CI): NTFS has no POSIX permission bits; Node reports every file and directory as
// 0o666 (0o444 read-only) with no exec bits. The POSIX mode rules (group/world writable, executable binary) are
// unix rules: on Windows they must not refuse an otherwise valid stage, while hashes, links, the closed file set and
// the templates still hold there. Reproduced on ANY OS by giving lib.cjs Windows' platform and NTFS-shaped modes.
function asWindows(fn) {
  const real = { lstat: fs.lstatSync, stat: fs.statSync, platform: Object.getOwnPropertyDescriptor(process, 'platform') };
  const ntfs = (st) => { if (st && typeof st.mode === 'number') Object.defineProperty(st, 'mode', { value: (st.mode & 0o170000) | 0o666 }); return st; };
  fs.lstatSync = function (...a) { return ntfs(real.lstat.apply(this, a)); };
  fs.statSync = function (...a) { return ntfs(real.stat.apply(this, a)); };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { fs.lstatSync = real.lstat; fs.statSync = real.stat; Object.defineProperty(process, 'platform', real.platform); }
}
test('Windows (NTFS modes 0o666, no exec bits): a valid stage verifies and its installed layout is accepted', () => {
  const d = fakeStage();
  assert.deepEqual(asWindows(() => L.verifyStage(d, { sourceCrate: crate })), []);
  assert.deepEqual(asWindows(() => L.checkInstalledLayout(d).filter((p) => !/unexpected installed file: receipt|runtime/.test(p))), []);
});
test('Windows: a tampered stage is still refused (hash, extra entry), only the POSIX mode rules are unix-only', () => {
  const d = fakeStage();
  fs.appendFileSync(path.join(d, 'abito-island'), 'x');
  fs.writeFileSync(path.join(d, 'extra'), 'x');
  const problems = asWindows(() => L.verifyStage(d)).join('\n');
  assert.match(problems, /abito-island hash differs from the receipt/);
  assert.match(problems, /unexpected stage entries/);
  assert.doesNotMatch(problems, /writable|not executable/);
});
test('unix keeps the POSIX mode rules (twin of the Windows case): group/world writable and a non-executable binary are refused', () => {
  if (process.platform === 'win32') return; // the rule is unix-only by design; the Windows twin is above
  const w = fakeStage(); fs.chmodSync(path.join(w, 'abito-island'), 0o664);
  const problems = L.verifyStage(w).join('\n');
  assert.match(problems, /abito-island is group\/world writable/);
  assert.match(problems, /binary is not executable/);
});

test('verify: devtools markers and an embedded source-tree path fail the stage', () => {
  for (const [marker, expect] of [['--remote-debugging-port', /devtools/], [crate, /source-tree path/]]) {
    const d = fakeStage();
    fs.writeFileSync(path.join(d, 'abito-island'), `#!/bin/true\n${marker}\n`, { mode: 0o755 });
    const r = readJson(path.join(d, 'receipt.json')); r.files['abito-island'] = L.sha256File(path.join(d, 'abito-island'));
    fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify(r));
    assert.match(L.verifyStage(d, { sourceCrate: crate }).join(), expect);
    fs.rmSync(d, { recursive: true });
  }
});
test('launcher: no args, refuses whole env families, forces X11, execs only its sibling binary', () => {
  const t = L.launcherText();
  assert.match(t, /\[ "\$#" -eq 0 \]/);
  assert.match(t, /export GDK_BACKEND=x11/);
  assert.match(t, /exec "\$here\/abito-island"$/m);
  // behaviour: run the launcher's guards (the sibling binary is a stub that must NOT start when refused)
  const cp = require('node:child_process');
  const d = fakeStage(); fs.writeFileSync(path.join(d, 'abito-island'), '#!/bin/sh\necho STARTED\n', { mode: 0o755 });
  const run = (extra, env) => cp.spawnSync(path.join(d, 'abito-island-launcher'), extra, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run(['--devtools'], {}).status, 64);
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_BIND_NOW', 'LD_ANYTHING_ELSE', 'GDK_DEBUG', 'GTK_MODULES',
    'WEBKIT_INSPECTOR_SERVER', 'ABITO_PROBE', 'ABITO_PROBE_VISUAL_DIR', 'ABITO_SOCKET_DIR', 'ABITO_BRIDGE_BASE', 'ABITO_MODELS_CONFIG_DIR',
    'ABITO_DESKTOP_SOCKET', 'ABITO_NATIVE_AUDIT', 'ABITO_NATIVE_VIEW_TEST', 'ABITO_FUTURE_KNOB_NOBODY_LISTED', 'GDK_SYNCHRONIZE', 'GTK_PATH']) {
    const r = run([], { [name]: '1' });
    assert.equal(r.status, 64, name);
    assert.doesNotMatch(r.stdout, /STARTED/, name);
    assert.match(r.stderr, new RegExp(`refusing ${name}`), name);
  }
  assert.equal(run([], { LDXYZ_NOT_LD: '1', LANG: 'C', HOME: '/x' }).status, 0, 'unrelated variables pass');
  // S5 (abito-avisos-ux): the GNOME session itself exports GTK_MODULES=gail:atk-bridge, so the menu entry could never open Abito.
  // ONLY that exact accessibility value is dropped (not loaded) before the guard; any other GTK_MODULES value is still refused.
  const a11y = run([], { GTK_MODULES: 'gail:atk-bridge', ABITO_PROJECT_ROOT: '/somewhere' });
  assert.equal(a11y.status, 0, a11y.stderr); assert.match(a11y.stdout, /STARTED/);
  for (const v of ['gail:atk-bridge:evil', 'evil:gail:atk-bridge', 'gail', 'atk-bridge', ' gail:atk-bridge']) {
    const r = run([], { GTK_MODULES: v }); assert.equal(r.status, 64, v); assert.doesNotMatch(r.stdout, /STARTED/, v);
  }
  const ok = run([], { ABITO_PROJECT_ROOT: '/somewhere' }); assert.equal(ok.status, 0, 'ABITO_PROJECT_ROOT is the one allowed knob'); assert.match(ok.stdout, /STARTED/);
  fs.rmSync(d, { recursive: true });
});
test('provenance gate: a dirty or untracked product file fails; a clean tree passes (real git repo)', () => {
  const cp = require('node:child_process');
  const repo = T.make('abito-git-');
  const git = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'x');
  const clean = L.requireClean(repo); assert.match(clean.head, /^[0-9a-f]{40}$/); assert.equal(clean.clean, true);
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); assert.throws(() => L.requireClean(repo), /not clean/);
  git('checkout', '--', 'a.txt'); assert.equal(L.requireClean(repo).clean, true);
  fs.writeFileSync(path.join(repo, 'new.rs'), 'x'); assert.throws(() => L.requireClean(repo), /not clean/);
  fs.rmSync(repo, { recursive: true });
});
test('verify: a receipt without HEAD / clean attestation fails', () => {
  const d = fakeStage(); const r = readJson(path.join(d, 'receipt.json'));
  delete r.provenance; fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify(r));
  assert.match(L.verifyStage(d).join(), /no git HEAD/); fs.rmSync(d, { recursive: true });
});
test('CSP: connect-src is EXACTLY self + ipc (no ipc.localhost.evil.com), object/frame/base none', () => {
  const d = copyCrate();
  const p = path.join(d, 'tauri.conf.json');
  const base = fs.readFileSync(p, 'utf8');
  for (const bad of ['http://ipc.localhost.evil.com', 'http://ipc.localhostx', 'https://ipc.localhost']) {
    fs.writeFileSync(p, base.replace('http://ipc.localhost;', `http://ipc.localhost ${bad};`));
    assert.throws(() => L.checkConfig(d), /connect-src must be exactly/, bad);
  }
  fs.writeFileSync(p, base.replace("object-src 'none'; ", ''));
  assert.throws(() => L.checkConfig(d), /object-src/);
  fs.writeFileSync(p, base.replace("'self' ipc: http://ipc.localhost", "'self' ipc: http://ipc.localhost.evil.com"));
  assert.throws(() => L.checkConfig(d), /connect-src must be exactly/);
  fs.writeFileSync(p, base.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"));
  assert.throws(() => L.checkConfig(d), /CSP allows unsafe/);
  fs.rmSync(d, { recursive: true });
});
test('gates: missing frontend file, extra plugin dependency, missing capability file all fail', () => {
  let d = copyCrate(); fs.rmSync(path.join(d, 'frontend', 'models.js'));
  assert.throws(() => L.checkFrontend(d), /missing=\[models\.js\]/); fs.rmSync(d, { recursive: true });
  d = copyCrate(); fs.appendFileSync(path.join(d, 'Cargo.toml'), '\ntauri-plugin-shell = "2"\n');
  assert.throws(() => L.checkConfig(d), /forbidden plugin/); fs.rmSync(d, { recursive: true });
  d = copyCrate(); fs.rmSync(path.join(d, 'capabilities', 'main.json'));
  assert.throws(() => L.checkConfig(d)); fs.rmSync(d, { recursive: true });
});
test('verify: the shipped binary must not carry the probe or the fake backend strings', () => {
  for (const marker of ['ABITO_PROBE', 'Prueba M3: propuesta servida por el backend falso', 'abito-validator-fake-terminal-launcher']) {
    const d = fakeStage();
    fs.writeFileSync(path.join(d, 'abito-island'), `#!/bin/true\n${marker}\n`, { mode: 0o755 });
    const r = readJson(path.join(d, 'receipt.json')); r.files['abito-island'] = L.sha256File(path.join(d, 'abito-island'));
    fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify(r));
    assert.match(L.verifyStage(d).join(), /probe\/fake/, marker);
    fs.rmSync(d, { recursive: true });
  }
});
test('law: XTest (synthetic input) is never a production dependency, and the shipped binary must not contain it', () => {
  // The real crate keeps xtest in a target-specific DEV table (Windows port U1a):
  // the law must read tables, not just the first `[dev-dependencies]` header.
  assert.doesNotThrow(() => L.checkConfig(crate), 'the real Cargo.toml keeps xtest under a dev-dependencies table');
  let d = copyCrate();
  fs.writeFileSync(path.join(d, 'Cargo.toml'), fs.readFileSync(path.join(d, 'Cargo.toml'), 'utf8').replace('x11rb = { version = "0.13", features = ["xkb"] }', 'x11rb = { version = "0.13", features = ["xkb", "xtest"] }'));
  assert.throws(() => L.checkConfig(d), /xtest/); fs.rmSync(d, { recursive: true });
  // Same crate, renamed table: a dev-dependencies table relabelled as a
  // target-specific PRODUCTION table must trip the law even though the text of
  // the dependency line did not change.
  d = copyCrate();
  fs.writeFileSync(path.join(d, 'Cargo.toml'), fs.readFileSync(path.join(d, 'Cargo.toml'), 'utf8').replace("[target.'cfg(unix)'.dev-dependencies]", "[target.'cfg(unix)'.dependencies]"));
  assert.throws(() => L.checkConfig(d), /xtest/, 'xtest smuggled into a target-specific production table'); fs.rmSync(d, { recursive: true });
  // And the plain form still trips: xtest moved into `[dependencies]`.
  d = copyCrate();
  fs.writeFileSync(path.join(d, 'Cargo.toml'), fs.readFileSync(path.join(d, 'Cargo.toml'), 'utf8').replace('[dependencies]', '[dependencies]\nx11rb = { version = "0.13", features = ["xtest"] }'));
  assert.throws(() => L.checkConfig(d), /xtest/, 'xtest in the plain production table'); fs.rmSync(d, { recursive: true });
  const st = fakeStage(); fs.writeFileSync(path.join(st, 'abito-island'), '#!/bin/true\nXTEST\n', { mode: 0o755 });
  const r = readJson(path.join(st, 'receipt.json')); r.files['abito-island'] = L.sha256File(path.join(st, 'abito-island'));
  fs.writeFileSync(path.join(st, 'receipt.json'), JSON.stringify(r));
  assert.match(L.verifyStage(st).join(), /XTEST/); fs.rmSync(st, { recursive: true });
});
test('desktop entry: quoted Exec, Icon, observed StartupWMClass; no unquoted path with spaces', () => {
  const t = L.desktopText();
  assert.match(t, /^Exec="@INSTALL_DIR@\/abito-island-launcher"$/m);
  assert.match(t, /^Icon=@INSTALL_DIR@\/abito-island\.png$/m);
  assert.match(t, /^StartupWMClass=Abito-island$/m);
});
test('identity never collides with the installed apps', () => {
  assert.match(L.desktopText(), /Exec="@INSTALL_DIR@\/abito-island-launcher"/);
  assert.doesNotMatch(L.desktopText() + L.launcherText(), /abito-desktop|com\.abitog\.Abito\b(?!Tauri)/);
});
console.log(`packaging-check: ${passed} passed`);

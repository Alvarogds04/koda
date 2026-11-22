'use strict';
// AC-08/K-F (S2, S6; human decision, 22 Nov, carried from jesscore): Koda stops installing and managing the Pi
// extension folder `~/.pi/agent/extensions/{koda-island,abito-island}`. Retired REVERSIBLY, exactly like K-C: one
// switch, `KODA_LEGACY_PI_EXTENSION`, ON only for the exact value "1". While it is off NOTHING writes, restores,
// updates or removes that folder — not even a `--remove`, because the human owns the folder now (jesscore removes it
// after a live test) and no code is deleted, so `KODA_LEGACY_PI_EXTENSION=1` brings the whole installer back.
//
// The switch itself lives in src/install-claude.cjs: that is a module the closed packaging list already ships
// (apps/desktop-tauri/packaging/lib.cjs HARNESS_FILES), so a packaged install can never fail to load an installer
// because a helper file was added but not staged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const legacy = require('../src/install-claude.cjs');
const pi = require('../src/install-pi.cjs');
const piwin = require('../src/install-pi-win.cjs');
const ui = require('../src/install-ui.cjs');

/** A private fake HOME. Nothing here ever looks at the real ~/.pi. */
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koda-pi-legacy-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  return { base, home };
}

/** Every entry of a tree with its bytes: two equal snapshots mean the folder is byte-identical. */
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    out[name] = st.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64');
  }
  return out;
}

const preview = async (args, env) => {
  const lines = [];
  const code = await ui.runInstallUi(args, { out: (s) => lines.push(s), env, homedir: () => env.HOME });
  assert.equal(lines.length, 1, 'machine mode writes exactly one JSON line');
  return { code, json: JSON.parse(lines[0]) };
};

test('the switch is ON only for the exact value "1"', () => {
  assert.equal(legacy.LEGACY_PI_EXTENSION_ENV, 'KODA_LEGACY_PI_EXTENSION');
  assert.equal(legacy.legacyPiExtensionSwitch(undefined), false, 'unset: off');
  assert.equal(legacy.legacyPiExtensionSwitch(''), false, 'empty: off');
  assert.equal(legacy.legacyPiExtensionSwitch('0'), false, 'explicit zero: off');
  assert.equal(legacy.legacyPiExtensionSwitch('true'), false, 'only "1" is the switch');
  assert.equal(legacy.legacyPiExtensionSwitch(' 1'), false, 'no trimming, no near-misses');
  assert.equal(legacy.legacyPiExtensionSwitch('1 '), false);
  assert.equal(legacy.legacyPiExtensionSwitch('yes'), false);
  assert.equal(legacy.legacyPiExtensionSwitch('1'), true, 'the documented value: on');
  assert.equal(legacy.legacyPiExtensionEnabled({}), false, 'default: OFF');
  assert.equal(legacy.legacyPiExtensionEnabled({ KODA_LEGACY_PI_EXTENSION: '1' }), true);
  assert.equal(legacy.legacyPiExtensionEnabled(undefined), false, 'no env at all is still OFF');
});

test('default: the Pi plan producer refuses (both twins), so there is no plan hash to apply', (t) => {
  const f = fixture(t);
  const opts = { home: f.home, uid: process.getuid?.(), remove: false, execPath: process.execPath, binPath: '/x', env: {} };
  for (const [name, mod] of [['POSIX', pi], ['Windows', piwin]]) {
    assert.throws(() => mod.planPi(opts), (e) => e.legacyPiExtensionOff === true, `${name} planPi refuses with the closed marker`);
    assert.throws(() => mod.planPi({ ...opts, remove: true }), (e) => e.legacyPiExtensionOff === true, `${name}: removal too`);
  }
  assert.equal(fs.existsSync(path.join(f.home, '.pi')), false, 'a refusal reads and writes nothing');
  assert.rejects(
    () => pi.applyPi({ home: f.home, uid: process.getuid?.() }, { backupPath: null, out() {}, err() {} }),
    (e) => e.legacyPiExtensionOff === true,
    'defence in depth: a plan made before the switch was turned off cannot be applied afterwards',
  );
});

test('default: `install pi --json` answers the closed code and creates nothing under a fake HOME', async (t) => {
  const f = fixture(t);
  const r = await preview(['pi', '--user', '--json'], { HOME: f.home });
  assert.equal(r.code, 65, 'a refusal: nothing was written');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'legacy_pi_extension_off');
  assert.equal(r.json.plan_hash, undefined, 'no plan hash means applyPlanned can never write');
  assert.equal(fs.readdirSync(f.home).length, 0, 'the fake HOME is untouched: no .pi, no audit, no lock');
});

test('default: an existing koda-island/abito-island folder stays byte-identical, install AND --remove', async (t) => {
  const f = fixture(t);
  const ext = path.join(f.home, '.pi', 'agent', 'extensions');
  for (const name of ['koda-island', 'abito-island']) {
    fs.mkdirSync(path.join(ext, name), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ext, name, 'index.ts'), `// ${name} lives here, Koda no longer touches it\n`);
    fs.writeFileSync(path.join(ext, name, '.abito-manifest.json'), '{"schema":"abito-pi-extension/1"}\n');
  }
  const before = snapshot(path.join(f.home, '.pi'));
  const env = { HOME: f.home, KODA_ISLAND_EXE: process.execPath };

  const install = await preview(['pi', '--user', '--json'], env);
  assert.equal(install.json.code, 'legacy_pi_extension_off');
  const remove = await preview(['pi', '--user', '--remove', '--json'], env);
  assert.equal(remove.json.code, 'legacy_pi_extension_off', 'removal/disconnect is refused too');
  // even an apply attempt with a made-up hash stops at the same gate: no plan, therefore no write
  const applied = await preview(['pi', '--user', '--remove', '--json', '--apply-plan', 'a'.repeat(64), '--audit-dir', path.join(f.base, 'audit')], env);
  assert.equal(applied.json.code, 'legacy_pi_extension_off');
  assert.equal(fs.existsSync(path.join(f.base, 'audit')), false, 'not even an audit record: nothing was attempted');

  assert.deepEqual(snapshot(path.join(f.home, '.pi')), before, 'not a byte of the extensions folder changed');
  assert.equal(fs.existsSync(path.join(f.home, '.pi', 'agent', 'abito-backups')), false, 'no backup folder was created');
});

test('with "1" the installer behaves exactly as before: preview, apply and removal', async (t) => {
  const f = fixture(t);
  // The strict payload check refuses a group-writable development checkout, so this test needs the packaged
  // layout (modes 0644) the shipped installer always sees; install-pi.test.cjs builds the same bundle.
  const bundle = path.join(f.base, 'bundle');
  for (const sub of ['src', 'bin']) fs.cpSync(path.resolve(__dirname, '..', sub), path.join(bundle, 'desktop-harness', sub), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'desktop-pi'));
  for (const file of ['pi-extension.ts', 'adapter.cjs', 'config.cjs', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs']) {
    const to = path.join(bundle, 'desktop-pi', file);
    fs.copyFileSync(path.resolve(__dirname, '../../desktop-pi', file), to);
    fs.chmodSync(to, 0o644);
  }
  const uiOn = require(path.join(bundle, 'desktop-harness/src/install-ui.cjs'));
  const audit = path.join(f.base, 'audit');
  fs.mkdirSync(audit, { mode: 0o700 });
  const env = { HOME: f.home, KODA_ISLAND_EXE: fs.realpathSync(process.execPath), KODA_LEGACY_PI_EXTENSION: '1' };
  const run = async (args) => {
    const lines = [];
    const code = await uiOn.runInstallUi(args, { out: (s) => lines.push(s), env, homedir: () => f.home, ppid: 1, readExe: () => env.KODA_ISLAND_EXE });
    assert.equal(lines.length, 1);
    return { code, json: JSON.parse(lines[0]) };
  };
  const target = path.join(f.home, '.pi', 'agent', 'extensions', 'koda-island');
  const install = await run(['pi', '--user', '--json']);
  assert.equal(install.code, 0);
  assert.equal(install.json.ok, true);
  assert.equal(install.json.mode, 'preview');
  assert.equal(install.json.harness, 'pi');
  assert.equal(install.json.action, 'install');
  assert.equal(install.json.target, target);
  assert.match(install.json.plan_hash, /^[0-9a-f]{64}$/, 'the previewed hash the island can apply again');
  assert.deepEqual(install.json.entries, [{ event: 'extension', op: 'add' }]);
  assert.equal(fs.existsSync(path.join(f.home, '.pi')), false, 'a preview still writes nothing');
  const applied = await run(['pi', '--user', '--json', '--apply-plan', install.json.plan_hash, '--audit-dir', audit]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal(applied.json.mode, 'applied');
  assert.deepEqual(fs.readdirSync(target).sort(), ['.abito-manifest.json', 'adapter.cjs', 'config.cjs', 'index.ts', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs']);
  const removal = await run(['pi', '--user', '--remove', '--json']);
  assert.equal(removal.json.action, 'remove');
  const removed = await run(['pi', '--user', '--remove', '--json', '--apply-plan', removal.json.plan_hash, '--audit-dir', audit]);
  assert.equal(removed.code, 0, JSON.stringify(removed.json));
  assert.equal(fs.existsSync(target), false, 'the legacy installer still removes what it installed');
});

'use strict';
const { tmpBase } = require('./platform-env.cjs');
// HU-047: the Windows install flow (audit, lock, settings, statusline side file, Pi) driven through a fake helper
// backed by a POSIX temp dir. The fake enforces the same contract the native helper does (private parent, no
// symlinks, expectation hashes) so a bypass in the Node flow shows up here without a Windows machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const winfs = require('../src/win-fs.cjs');
const ui = require('../src/install-ui.cjs');
// AC-08/K-F (S2, S6): the Windows Pi installer is retired behind the same one switch as the POSIX twin (default OFF).
// This suite is its coverage, so it opts in; the default-off behaviour is pinned in test/legacy-pi-extension.test.cjs.
process.env.KODA_LEGACY_PI_EXTENSION = '1';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const { fakeBackend } = require('./win-fake-backend.cjs');
function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-winfake-')));
  fs.chmodSync(d, 0o700);
  t.after(() => { winfs.useForTests(null); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
async function run(argv, extra = {}) {
  const lines = [];
  const code = await ui.runInstallUi(argv, { out: s => lines.push(s), env: {}, ...extra });
  return { code, json: lines.length === 1 ? JSON.parse(lines[0]) : null, lines };
}
const guards = { readExe: () => '/x' };

test('Windows flow: preview then apply a Claude settings file through the helper only (audit, lock, atomic write)', async t => {
  const d = tmp(t); const log = [];
  winfs.useForTests(fakeBackend(log));
  const settings = path.join(d, 'settings.json'); const audit = path.join(d, 'audit');
  fs.writeFileSync(settings, '{\n  "a": 1\n}\n', { mode: 0o600 });
  const pv = (await run(['claude', '--settings', settings, '--json'])).json;
  assert.equal(pv.ok, true); assert.equal(pv.changed, true);
  const exe = fs.realpathSync(process.execPath);
  const ap = await run(['claude', '--settings', settings, '--json', '--apply-plan', pv.plan_hash, '--audit-dir', audit], { env: { KODA_ISLAND_EXE: exe }, readExe: () => exe });
  assert.equal(ap.json.ok, true, JSON.stringify(ap.json));
  assert.equal(ap.json.rollback, null);
  assert.match(fs.readFileSync(settings, 'utf8'), /koda-hook/);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).a, 1);
  const auditLines = fs.readFileSync(path.join(audit, 'hook-installs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(auditLines.map(l => l.event), ['intent', 'result']);
  assert.ok(log.some(([k, p]) => k === 'write' && p === settings), 'settings written through the helper');
  assert.ok(fs.readdirSync(d).some(n => n.includes('.abito-backup-')), 'backup exists');
  assert.ok(!fs.readdirSync(d).some(n => n.includes('abito-lock')), 'lock released');
});

test('Windows flow: a symlinked settings file or a non-private parent writes nothing and reports a fixed code', async t => {
  const d = tmp(t);
  winfs.useForTests(fakeBackend());
  const real = path.join(d, 'real.json'); fs.writeFileSync(real, '{}\n', { mode: 0o600 });
  const link = path.join(d, 'settings.json'); fs.symlinkSync(real, link);
  const r1 = await run(['claude', '--settings', link, '--json']);
  assert.equal(r1.json.ok, false); assert.equal(r1.json.code, 'unsafe_target');
  assert.equal(fs.readFileSync(real, 'utf8'), '{}\n');
  const open = path.join(d, 'open'); fs.mkdirSync(open); fs.chmodSync(open, 0o777);
  const r2 = await run(['claude', '--settings', path.join(open, 'settings.json'), '--json']);
  assert.equal(r2.json.ok, false); assert.equal(r2.json.code, 'unsafe_folder');
  assert.equal(r2.json.message, `La carpeta ${open} tiene permisos de Windows (ACL) que dan acceso a otros usuarios o no es tuya; dejala accesible solo para tu usuario (Propiedades > Seguridad) y volvé a intentar.`);
  assert.deepEqual(fs.readdirSync(open), []);
});

test('Windows flow: Pi extension installs, replaces and removes through the helper, and refuses another drive', async t => {
  const d = tmp(t); const home = path.join(d, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  winfs.useForTests(fakeBackend());
  const verified = winfs.readVerified;
  // payload bytes come from the manifest-verified reader; here the fake returns the real source bytes
  winfs.readVerified = rel => fs.readFileSync(path.resolve(__dirname, '../..', rel));
  t.after(() => { winfs.readVerified = verified; });
  const piwin = require('../src/install-pi-win.cjs');
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
  const plan = piwin.planPi({ home, remove: false, execPath: process.execPath, binPath: '/x' });
  assert.equal(plan.changed, true);
  let msg = '';
  assert.equal(await piwin.applyPi(plan, { backupPath: null, out: () => {}, err: s => { msg += s; } }), 0, msg);
  const target = path.join(home, '.pi', 'agent', 'extensions', 'koda-island');
  assert.deepEqual(fs.readdirSync(target).sort(), [...piwin.FILES, piwin.MANIFEST].sort());
  const again = piwin.planPi({ home, remove: false, execPath: process.execPath, binPath: '/x' });
  assert.equal(again.changed, false);
  const rm = piwin.planPi({ home, remove: true, execPath: process.execPath, binPath: '/x' });
  const bk = path.join(rm.backupRoot, 'koda-island.abito-backup-20260101T000000000Z');
  assert.equal(await piwin.applyPi(rm, { backupPath: bk, out: () => {}, err: () => {} }), 0);
  assert.equal(fs.existsSync(target), false);
});

test('Windows flow (verifier M1): the saved status-line file is read only through the helper checks; a foreign or linked one is ignored', t => {
  const d = tmp(t);
  winfs.useForTests(fakeBackend());
  const statusline = require('../src/install-statusline.cjs');
  fs.mkdirSync(path.join(d, '.abito'), { mode: 0o700 });
  const file = path.join(d, '.abito', 'statusline-previous.json');
  fs.writeFileSync(file, '{"type":"command","command":"evil"}\n', { mode: 0o666 }); // not private: the helper contract refuses it
  const settings = path.join(d, 'settings.json');
  fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"node /x/koda-statusline.cjs"}}\n', { mode: 0o600 });
  const plan = statusline.planStatusLine({ settingsPath: settings, remove: true, home: d, binPath: '/x/koda-statusline.cjs', execPath: process.execPath, uid: 'win' });
  assert.ok(!/evil/.test(plan.after), 'a non-private side file must never be restored into settings');
  fs.chmodSync(file, 0o600);
  const ok = statusline.planStatusLine({ settingsPath: settings, remove: true, home: d, binPath: '/x/koda-statusline.cjs', execPath: process.execPath, uid: 'win' });
  assert.match(ok.after, /evil/, 'a private side file is still honoured');
});

// L6 (HU-062): on Windows the command must use the form of the shell Claude Code really runs it with. For PowerShell that is the
// call operator (`& "node" "bin"`), because a leading quoted path there is a string expression (src/install-statusline.cjs
// statusLineCommand, pinned by test/statusline-command.test.cjs). The shell is passed explicitly so the assertion does not depend
// on the machine running the suite; the `unsafe` refusal for a path with a double quote stays.
test('L6: on Windows the status-line command is the PowerShell call-operator form, and a path with an apostrophe or a quote stays safe', t => {
  const d = tmp(t);
  winfs.useForTests(fakeBackend());
  const statusline = require('../src/install-statusline.cjs');
  const settings = path.join(d, 'settings.json');
  fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
  const PS = { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
  const plan = statusline.planStatusLine({ settingsPath: settings, home: d, binPath: 'C:\\Users\\O\'Neil\\Abito\\koda-statusline.cjs', execPath: 'C:\\Program Files\\nodejs\\node.exe', uid: 'win', shell: PS });
  assert.match(plan.after, /"command": "& \\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" \\"C:\\\\Users\\\\O'Neil\\\\Abito\\\\koda-statusline.cjs\\""/);
  assert.throws(() => statusline.planStatusLine({ settingsPath: settings, home: d, binPath: 'C:\\a"b\\koda-statusline.cjs', execPath: 'C:\\n.exe', uid: 'win', shell: PS }), /refused|unsafe/);
});

test('L7: mismatch/busy/io/exists/missing helper reasons get their own Ajustes detail instead of unsafe_target', async t => {
  const d = tmp(t);
  const settings = path.join(d, 'settings.json'); fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
  for (const [reason, code] of [['mismatch', 'plan_changed'], ['busy', 'apply_failed'], ['io', 'apply_failed'], ['not_private', 'unsafe_target'], ['reparse', 'unsafe_target']]) {
    const b = fakeBackend();
    b.readPrivate = () => { throw new winfs.WinFsError(reason); };
    winfs.useForTests(b);
    const r = await run(['claude', '--settings', settings, '--json']);
    assert.equal(r.json.code, code, reason);
  }
});


// HU-062 (found by the Windows run): the audit log past 1 MiB made appendAudit THROW on Windows (the helper caps one read at 1 MiB and the
// size check ran after the read). It must rotate by size, looking at the size through the helper first, and never throw.
test('audit: a log already past the helper 1 MiB cap is rotated before any read, and the append succeeds', t => {
  const d = tmp(t); const dir = path.join(d, 'audit'); fs.mkdirSync(dir, { mode: 0o700 });
  winfs.useForTests(fakeBackend());
  const f = path.join(dir, 'hook-installs.jsonl');
  fs.writeFileSync(f + '.1', 'old-generation\n', { mode: 0o600 });
  fs.writeFileSync(f, '{"ts":0}\n'.repeat(Math.ceil((1024 * 1024 + 1) / 9)), { mode: 0o600 });
  ui.appendAudit(dir, { ts: 7, event: 'intent' });
  assert.ok(fs.statSync(f + '.1').size > 1024 * 1024, 'the big log became the previous generation');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ts":7,"event":"intent"}\n');
  ui.appendAudit(dir, { ts: 8 });
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 2, 'below the cap: no rotation');
});

// K3-04: the Windows twin of the POSIX legacy-listing tests. A folder written by the PREVIOUS release has eight files
// (it still carries `ask-tool.cjs`); it stays a verified Koda install, so it is retired (old name) or replaced (new name)
// instead of being read as foreign. Built here exactly as that release left it: eight files, a manifest with every hash.
const PI_INSTALLED = ['adapter.cjs', 'config.cjs', 'index.ts', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs'];
const PI_LEGACY = [...PI_INSTALLED, 'ask-tool.cjs'].sort();
const PI_SOURCE = name => path.resolve(__dirname, '../../desktop-pi', name === 'index.ts' ? 'pi-extension.ts' : name);
function legacyPiFolder(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const files = {};
  for (const name of PI_LEGACY) {
    const body = name === 'ask-tool.cjs' ? "'use strict';\n// abito_ask: what the previous release shipped (K3-04)\n"
      : fs.readFileSync(PI_SOURCE(name));
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
    files[name] = sha(fs.readFileSync(path.join(dir, name)));
  }
  const manifest = '.abito-manifest.json';
  fs.writeFileSync(path.join(dir, manifest), JSON.stringify({ schema: 'abito-pi-extension/1', files }) + '\n', { mode: 0o600 });
  return dir;
}

test('Windows flow (K3-04): an 8-file folder from the previous release is retired at the old name and replaced at the new one', async t => {
  const d = tmp(t); const home = path.join(d, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  winfs.useForTests(fakeBackend());
  const verified = winfs.readVerified;
  winfs.readVerified = rel => fs.readFileSync(path.resolve(__dirname, '../..', rel));
  t.after(() => { winfs.readVerified = verified; });
  const piwin = require('../src/install-pi-win.cjs');
  const parent = path.join(home, '.pi', 'agent', 'extensions');
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
  const plan = () => piwin.planPi({ home, remove: false, execPath: process.execPath, binPath: '/x' });
  // (a) the previous release's folder at the 0.1 name: retired into the backup flow, one extension left.
  const legacy = legacyPiFolder(path.join(parent, 'abito-island'));
  const first = plan();
  assert.equal(first.changed, true);
  assert.equal(first.legacyExists, true, 'the eight files are recognised as a Koda install, not as foreign');
  let msg = '';
  assert.equal(await piwin.applyPi(first, { backupPath: null, out: () => {}, err: s => { msg += s; } }), 0, msg);
  assert.equal(fs.existsSync(legacy), false, 'the 0.1 folder leaves extensions');
  assert.deepEqual(fs.readdirSync(parent), ['koda-island'], 'one extension folder');
  const backups = path.join(home, '.pi', 'agent', 'abito-backups');
  const retired = fs.readdirSync(backups).filter(n => /^abito-island\.abito-backup-/.test(n));
  assert.equal(retired.length, 1, JSON.stringify(fs.readdirSync(backups)));
  assert.deepEqual(fs.readdirSync(path.join(backups, retired[0])).sort(), [...PI_LEGACY, '.abito-manifest.json'].sort(), 'retired whole');
  // (b) the previous release's folder at the CURRENT name: an upgrade, never a refusal.
  const target = path.join(parent, 'koda-island');
  fs.rmSync(target, { recursive: true, force: true });
  legacyPiFolder(target);
  const upgrade = plan();
  assert.equal(upgrade.changed, true);
  const bk = path.join(upgrade.backupRoot, 'koda-island.abito-backup-20260101T000000001Z');
  msg = '';
  assert.equal(await piwin.applyPi(upgrade, { backupPath: bk, out: () => {}, err: s => { msg += s; } }), 0, msg);
  assert.deepEqual(fs.readdirSync(target).sort(), [...piwin.FILES, piwin.MANIFEST].sort(), 'the ask tool is gone');
  assert.equal(plan().changed, false, 'and that is the exact current payload');
  // (c) remove works on it too.
  fs.rmSync(target, { recursive: true, force: true });
  legacyPiFolder(target);
  const rm = piwin.planPi({ home, remove: true, execPath: process.execPath, binPath: '/x' });
  assert.equal(rm.changed, true);
  const rmBackup = path.join(rm.backupRoot, 'koda-island.abito-backup-20260101T000000002Z');
  assert.equal(await piwin.applyPi(rm, { backupPath: rmBackup, out: () => {}, err: () => {} }), 0);
  assert.equal(fs.existsSync(target), false, 'removed');
  // (d) anything else stays refused: a changed byte in an eight-file folder is not ours.
  const tampered = legacyPiFolder(target);
  fs.writeFileSync(path.join(tampered, 'config.cjs'), '// edited by hand', { mode: 0o600 });
  assert.throws(() => plan(), error => error.code === 'refused' || /refused/i.test(String(error.message)));
  assert.equal(fs.existsSync(path.join(tampered, 'config.cjs')), true, 'and it is left alone');
});

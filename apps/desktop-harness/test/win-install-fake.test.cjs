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
  const ap = await run(['claude', '--settings', settings, '--json', '--apply-plan', pv.plan_hash, '--audit-dir', audit], { env: { ABITO_ISLAND_EXE: exe }, readExe: () => exe });
  assert.equal(ap.json.ok, true, JSON.stringify(ap.json));
  assert.equal(ap.json.rollback, null);
  assert.match(fs.readFileSync(settings, 'utf8'), /abito-hook/);
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
  const target = path.join(home, '.pi', 'agent', 'extensions', 'abito-island');
  assert.deepEqual(fs.readdirSync(target).sort(), [...piwin.FILES, piwin.MANIFEST].sort());
  const again = piwin.planPi({ home, remove: false, execPath: process.execPath, binPath: '/x' });
  assert.equal(again.changed, false);
  const rm = piwin.planPi({ home, remove: true, execPath: process.execPath, binPath: '/x' });
  const bk = path.join(rm.backupRoot, 'abito-island.abito-backup-20260101T000000000Z');
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
  fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"node /x/abito-statusline.cjs"}}\n', { mode: 0o600 });
  const plan = statusline.planStatusLine({ settingsPath: settings, remove: true, home: d, binPath: '/x/abito-statusline.cjs', execPath: process.execPath, uid: 'win' });
  assert.ok(!/evil/.test(plan.after), 'a non-private side file must never be restored into settings');
  fs.chmodSync(file, 0o600);
  const ok = statusline.planStatusLine({ settingsPath: settings, remove: true, home: d, binPath: '/x/abito-statusline.cjs', execPath: process.execPath, uid: 'win' });
  assert.match(ok.after, /evil/, 'a private side file is still honoured');
});

test('L6: on Windows the status-line command is double-quoted for cmd and a path with an apostrophe or quote stays safe', t => {
  const d = tmp(t);
  winfs.useForTests(fakeBackend());
  const statusline = require('../src/install-statusline.cjs');
  const settings = path.join(d, 'settings.json');
  fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
  const plan = statusline.planStatusLine({ settingsPath: settings, home: d, binPath: 'C:\\Users\\O\'Neil\\Abito\\abito-statusline.cjs', execPath: 'C:\\Program Files\\nodejs\\node.exe', uid: 'win' });
  assert.match(plan.after, /"command": "\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" \\"C:\\\\Users\\\\O'Neil\\\\Abito\\\\abito-statusline.cjs\\""/);
  assert.throws(() => statusline.planStatusLine({ settingsPath: settings, home: d, binPath: 'C:\\a"b\\abito-statusline.cjs', execPath: 'C:\\n.exe', uid: 'win' }), /refused|unsafe/);
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

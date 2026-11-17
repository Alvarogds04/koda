'use strict';
const { tmpBase } = require('./platform-env.cjs');
// macOS: tmpBase() is /var/folders/... and /var is a symlink to /private/var; the installers refuse a settings path that contains a
// symlink (correct for a real home), so the fixture home is canonicalized (as the other install tests already do).
// Installer for Copilot CLI: a hooks file Koda OWNS (~/.copilot/hooks/koda-island.json). Never settings.json, never someone else's file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planCopilotHooks, COPILOT_PROFILE } = require('../src/install-copilot.cjs');
const core = require('../src/install-claude.cjs');
const ui = require('../src/install-ui.cjs');

const BIN = '/opt/koda/bin/koda-hook.cjs', NODE = '/usr/bin/node';
const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-cop-'))); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const plan = (p, o = {}) => planCopilotHooks({ settingsPath: p, binPath: BIN, execPath: NODE, ...o });

test('a new file: version 1, permissionRequest + sessionEnd entries that run node + bin directly (exec/args, no shell) with the hook deadlines', t => {
  const p = path.join(tmp(t), 'koda-island.json');
  const pl = plan(p);
  assert.equal(pl.changed, true); assert.equal(pl.exists, false);
  assert.deepEqual(JSON.parse(pl.after), { version: 1, hooks: { permissionRequest: [{ type: 'command', exec: NODE,
    args: [BIN, 'copilot', 'permission-request', '--timeout-sec', '35'], timeoutSec: 35 }],
    sessionEnd: [{ type: 'command', exec: NODE, args: [BIN, 'copilot', 'stop'], timeoutSec: 15 }] } });
});
test('idempotent; a timeout change replaces ours; remove leaves a valid empty hooks file; other hooks in the file survive', t => {
  const d = tmp(t), p = path.join(d, 'koda-island.json');
  const other = { type: 'command', bash: 'echo hi', timeoutSec: 5 };
  fs.writeFileSync(p, JSON.stringify({ version: 1, hooks: { preToolUse: [other], permissionRequest: [other] } }, null, 2));
  const one = plan(p); const o1 = JSON.parse(one.after);
  assert.deepEqual(o1.hooks.preToolUse, [other]); assert.equal(o1.hooks.permissionRequest.length, 2); assert.deepEqual(o1.hooks.permissionRequest[0], other);
  fs.writeFileSync(p, one.after);
  assert.equal(plan(p).changed, false);
  const sixty = JSON.parse(plan(p, { timeoutSec: 60 }).after);
  assert.equal(sixty.hooks.permissionRequest.length, 2); assert.equal(sixty.hooks.permissionRequest[1].timeoutSec, 60);
  const gone = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(gone.after), { version: 1, hooks: { preToolUse: [other], permissionRequest: [other] } });
  assert.equal(o1.hooks.sessionEnd.length, 1);
  fs.writeFileSync(p, JSON.stringify({ version: 1, hooks: {} }));
  assert.equal(plan(p, { remove: true }).changed, false);
});
test('refuses what it cannot own safely: not an object, wrong version, hooks of the wrong type, invalid JSON, symlink, relative path', t => {
  const d = tmp(t), p = path.join(d, 'koda-island.json');
  for (const text of ['[]', '{"version":2,"hooks":{}}', '{"version":1,"hooks":[]}', '{"version":1,"hooks":{"permissionRequest":{}}}', 'nope', '{"version":1,"hooks":{}} x']) {
    fs.writeFileSync(p, text);
    assert.throws(() => plan(p), e => e.exitCode === 65, text);
  }
  fs.rmSync(p); fs.symlinkSync('/etc/hostname', p);
  assert.throws(() => plan(p), e => e.exitCode === 65);
  assert.throws(() => plan('relative.json'), e => e.exitCode === 65);
  assert.throws(() => plan(path.join(d, 'x.json'), { execPath: 'node' }), e => e.exitCode === 65);
});
test('island install mode: preview then apply with backup + audit, the same trusted-click machinery as Claude/Codex', async t => {
  const d = tmp(t), p = path.join(d, 'koda-island.json'), audit = path.join(d, 'audit');
  fs.writeFileSync(p, JSON.stringify({ version: 1, hooks: {} }, null, 2));
  const lines = [];
  const opts = { env: { ...process.env, HOME: d }, binPath: BIN, execPath: NODE, out: s => lines.push(JSON.parse(s)), onJson: () => {} };
  assert.equal(await ui.runInstallUi(['copilot', '--settings', p, '--json'], opts), 0);
  const pv = lines[0];
  assert.equal(pv.ok, true); assert.equal(pv.harness, 'copilot'); assert.deepEqual(pv.entries, [{ event: 'permissionRequest', op: 'add' }, { event: 'sessionEnd', op: 'add' }]);
  assert.equal(pv.requires_trust_review, false);
  // applying needs the island guards (parent = island exe), which a unit test cannot satisfy: it must refuse, writing nothing
  const before = fs.readFileSync(p, 'utf8');
  assert.equal(await ui.runInstallUi(['copilot', '--settings', p, '--json', '--apply-plan', pv.plan_hash, '--audit-dir', audit], { ...opts, ppid: 1 }), 77);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});
test('profile exposes the copilot name and a default hook file under ~/.copilot/hooks', () => {
  assert.equal(COPILOT_PROFILE.name, 'copilot');
  assert.deepEqual(COPILOT_PROFILE.defaultFile, ['.copilot', 'hooks', 'koda-island.json']);
});
test('apply through the shared core: backup of an existing file, verified write, remove restores the equivalent file; a refused word writes nothing', async t => {
  const { runInstallCopilot } = require('../src/install-copilot.cjs');
  const d = tmp(t), p = path.join(d, 'koda-island.json');
  const original = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'echo' }] } }, null, 2) + '\n';
  fs.writeFileSync(p, original);
  const base = { isTTY: () => true, binPath: BIN, execPath: NODE, out: () => {}, err: () => {}, now: () => new Date('2026-01-02T03:04:05Z') };
  assert.equal(await runInstallCopilot(['copilot', '--settings', p, '--apply'], { ...base, prompt: async () => 'nope' }), 1);
  assert.equal(fs.readFileSync(p, 'utf8'), original);
  assert.equal(await runInstallCopilot(['copilot', '--settings', p, '--apply'], { ...base, prompt: async () => 'install' }), 0);
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(written.hooks.permissionRequest.length, 1); assert.deepEqual(written.hooks.preToolUse, [{ type: 'command', bash: 'echo' }]);
  const backups = fs.readdirSync(d).filter(f => f.includes('.abito-backup-'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(d, backups[0]), 'utf8'), original);
  assert.equal(await runInstallCopilot(['copilot', '--settings', p, '--remove', '--apply'], { ...base, now: () => new Date('2026-01-02T03:04:06Z'), prompt: async () => 'remove' }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), JSON.parse(original));
});

// --- K2-04 (S2, S4): the Koda 0.1 hooks file is recognised and retired --------------------------
// Copilot loads every *.json in ~/.copilot/hooks, so a 0.1 `abito-island.json` left next to the new `koda-island.json` would show
// two cards per notice. Installing at the new default name retires it: our entries are stripped, everything else stays, and the
// original bytes are kept in a dated backup. A file at the old name without our entries is somebody else's and is never touched.

const OLD_NAME = 'abito-island.json', NEW_NAME = 'koda-island.json';
const LEGACY_BIN = '/opt/koda-0.1/desktop-harness/bin/abito-hook.cjs';
const legacyHook = event => ({ type: 'command', exec: NODE, args: [LEGACY_BIN, 'copilot', event === 'permissionRequest' ? 'permission-request' : 'stop'], timeoutSec: 35 });
const WHEN = () => new Date('2026-01-02T03:04:05.678Z');
async function applyPlan(pl) {
  let out = '', err = '';
  const code = await core.applyPlan(pl, { backupPath: core.backupPathFor(pl.settingsPath, WHEN()), now: WHEN, verify: COPILOT_PROFILE.verify(pl),
    out: s => { out += s; }, err: s => { err += s; } });
  return { code, out, err };
}
const hooksDir = t => { const dir = path.join(tmp(t), 'hooks'); fs.mkdirSync(dir); return dir; };
const doc = hooks => JSON.stringify({ version: 1, hooks }, null, 2) + '\n';

test('K2-04: a 0.1 file plus a foreign entry ends with ONE Koda file, the 0.1 entries gone and the foreign entry intact', async t => {
  const dir = hooksDir(t);
  const foreign = { type: 'command', bash: 'echo hi', timeoutSec: 5 };
  const legacyFile = path.join(dir, OLD_NAME);
  const original = doc({ permissionRequest: [legacyHook('permissionRequest')], preToolUse: [foreign] });
  fs.writeFileSync(legacyFile, original);
  const p = path.join(dir, NEW_NAME);
  const pl = plan(p);
  assert.equal(pl.changed, true);
  assert.equal(pl.retire.length, 1, 'the 0.1 file is part of the plan');
  assert.deepEqual(JSON.parse(pl.retire[0].after), { version: 1, hooks: { preToolUse: [foreign] } }, 'ours stripped, the foreign entry kept');
  const done = await applyPlan(pl);
  assert.equal(done.code, 0, done.err);
  const hooks = JSON.parse(fs.readFileSync(p, 'utf8')).hooks;
  assert.equal(hooks.permissionRequest.filter(h => h.args && h.args[0] === BIN).length, 1, 'exactly one Koda permission entry');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).hooks.preToolUse, [foreign], 'the foreign entry survives in place');
  const backups = fs.readdirSync(dir).filter(n => n.startsWith(`${OLD_NAME}.abito-backup-`));
  assert.equal(backups.length, 1, 'the 0.1 bytes are kept in a dated backup');
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
});

test('K2-04: with the new file already exact, a 0.1 file alone still drives the plan and is cleaned without rewriting the target', async t => {
  const dir = hooksDir(t), p = path.join(dir, NEW_NAME), legacyFile = path.join(dir, OLD_NAME);
  assert.equal((await applyPlan(plan(p))).code, 0, 'first install');
  const exact = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(legacyFile, doc({ sessionEnd: [legacyHook('sessionEnd')] }));
  const pl = plan(p);
  assert.equal(pl.changed, true, 'the 0.1 file is still a change');
  assert.equal(pl.patch, null, 'the target itself is already ours');
  const done = await applyPlan(pl);
  assert.equal(done.code, 0, done.err);
  assert.equal(fs.readFileSync(p, 'utf8'), exact, 'the Koda file is not rewritten');
  assert.equal(fs.existsSync(legacyFile), false, 'a file that only held our entries is retired');
});

test('K2-04: remove strips our 0.1 entries too; a file at the old name without them is never touched', async t => {
  const dir = hooksDir(t), p = path.join(dir, NEW_NAME), legacyFile = path.join(dir, OLD_NAME);
  assert.equal((await applyPlan(plan(p))).code, 0);
  fs.writeFileSync(legacyFile, doc({ permissionRequest: [legacyHook('permissionRequest')] }));
  const removed = await applyPlan(plan(p, { remove: true }));
  assert.equal(removed.code, 0, removed.err);
  assert.equal(fs.existsSync(legacyFile), false, 'the 0.1 file only had our entries: it goes');
  const foreign = doc({ preToolUse: [{ type: 'command', bash: 'echo mine' }] });
  fs.writeFileSync(legacyFile, foreign);
  assert.deepEqual(plan(p).retire, [], 'no entry of ours there: nothing to retire');
  assert.equal((await applyPlan(plan(p, { remove: true }))).code, 0);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), foreign);
});

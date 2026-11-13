'use strict';
const { tmpBase } = require('./platform-env.cjs');
// macOS: tmpBase() is /var/folders/... and /var is a symlink to /private/var; the installers refuse a settings path that contains a
// symlink (correct for a real home), so the fixture home is canonicalized (as the other install tests already do).
// Installer: Koda owns ONE plugin file (~/.config/opencode/plugins/koda-island.js). Never opencode.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planOpencodePlugin, runInstallOpencode, MARKER, STUB, OPENCODE_PROFILE } = require('../src/install-opencode.cjs');
const core = require('../src/install-claude.cjs');

const BIN = '/opt/koda/bin/koda-hook.cjs', NODE = '/usr/bin/node';
const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-ocI-'))); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const plan = (p, o = {}) => planOpencodePlugin({ settingsPath: p, binPath: BIN, execPath: NODE, ...o });

test('a new plugin file carries the ownership marker and the exact deadline', t => {
  const p = path.join(tmp(t), 'koda-island.js'); const pl = plan(p);
  assert.equal(pl.changed, true); assert.equal(pl.exists, false); assert.ok(pl.after.startsWith(MARKER));
  assert.ok(pl.after.includes(JSON.stringify(BIN)) && pl.after.includes(JSON.stringify(NODE)));
  assert.equal(plan(p, { timeoutSec: 60 }).after.includes('60'), true);
});
test('idempotent; a file that is NOT ours is refused, never overwritten; remove leaves an inert stub of ours', t => {
  const d = tmp(t), p = path.join(d, 'koda-island.js');
  fs.writeFileSync(p, plan(p).after); assert.equal(plan(p).changed, false);
  const gone = plan(p, { remove: true }); assert.equal(gone.changed, true); assert.ok(gone.after.startsWith(MARKER)); assert.ok(!gone.after.includes('permission.ask'));
  fs.writeFileSync(p, gone.after); assert.equal(plan(p, { remove: true }).changed, false);
  fs.writeFileSync(p, 'export default async () => ({})\n');
  assert.throws(() => plan(p), e => e.exitCode === 65); assert.throws(() => plan(p, { remove: true }), e => e.exitCode === 65);
  fs.rmSync(p); fs.symlinkSync('/etc/hostname', p); assert.throws(() => plan(p), e => e.exitCode === 65);
  assert.throws(() => plan('rel.js'), e => e.exitCode === 65);
});
test('apply with backup and typed word; the installed file is valid ESM; a wrong word writes nothing', async t => {
  const d = tmp(t), p = path.join(d, 'koda-island.js');
  fs.writeFileSync(p, STUB); // an earlier inert stub of ours
  const stub = fs.readFileSync(p, 'utf8');
  const base = { isTTY: () => true, binPath: BIN, execPath: NODE, out: () => {}, err: () => {}, now: () => new Date('2026-01-02T03:04:05Z') };
  assert.equal(await runInstallOpencode(['opencode', '--settings', p, '--apply'], { ...base, prompt: async () => 'no' }), 1);
  assert.equal(fs.readFileSync(p, 'utf8'), stub);
  assert.equal(await runInstallOpencode(['opencode', '--settings', p, '--apply'], { ...base, prompt: async () => 'install' }), 0);
  const mod = await import(require('node:url').pathToFileURL(p).href + '?v=1'); assert.equal(typeof mod.AbitoIslandPlugin, 'function');
  assert.equal(fs.readdirSync(d).filter(f => f.includes('.abito-backup-')).length, 1);
});
test('profile', () => { assert.equal(OPENCODE_PROFILE.name, 'opencode'); assert.deepEqual(OPENCODE_PROFILE.events, ['permission.ask', 'event']); assert.deepEqual(OPENCODE_PROFILE.defaultFile, ['.config', 'opencode', 'plugins', 'koda-island.js']); });

// --- K2-04 (S2, S4): the Koda 0.1 plugin is recognised and retired -----------------------------
// A 0.1 `abito-island.js` in the plugins folder would be loaded next to `koda-island.js` (two cards per notice). Installing at the
// new default name retires it into a dated backup; a plugin carrying the 0.1 ownership marker is still ours and is replaced in
// place; a file without either marker stays foreign, exactly as before.

const LEGACY_MARKER_OC = '// abito-island-managed: opencode-plugin/1\n';
const OLD_PLUGIN = 'abito-island.js', NEW_PLUGIN = 'koda-island.js';
const WHEN = () => new Date('2026-01-02T03:04:05.678Z');
async function applyPlan(pl) {
  let out = '', err = '';
  const code = await core.applyPlan(pl, { backupPath: core.backupPathFor(pl.settingsPath, WHEN()), now: WHEN, verify: OPENCODE_PROFILE.verify(pl),
    out: s => { out += s; }, err: s => { err += s; } });
  return { code, out, err };
}
const plugins = t => { const dir = path.join(tmp(t), 'plugins'); fs.mkdirSync(dir); return dir; };

test('K2-04: a 0.1 plugin at the old name is retired, so exactly ONE plugin survives', async t => {
  const dir = plugins(t);
  const old = path.join(dir, OLD_PLUGIN), p = path.join(dir, NEW_PLUGIN);
  fs.writeFileSync(old, LEGACY_MARKER_OC + 'export const AbitoIslandPlugin = async () => ({});\n');
  const pl = plan(p);
  assert.equal(pl.changed, true);
  assert.deepEqual(pl.retire.map(r => [path.basename(r.abs), r.after]), [[OLD_PLUGIN, null]], 'the 0.1 file is retired whole');
  const done = await applyPlan(pl);
  assert.equal(done.code, 0, done.err);
  assert.equal(fs.existsSync(old), false, 'the 0.1 plugin is gone');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.js')), [NEW_PLUGIN], 'one plugin, the Koda one');
  assert.ok(fs.readFileSync(p, 'utf8').startsWith(MARKER));
  assert.equal(fs.readdirSync(dir).filter(n => n.startsWith(`${OLD_PLUGIN}.abito-backup-`)).length, 1, 'its bytes are kept in a backup');
});

test('K2-04: a plugin carrying the 0.1 marker at OUR path is replaced in place; one without any marker stays foreign', async t => {
  const dir = plugins(t), p = path.join(dir, NEW_PLUGIN);
  fs.writeFileSync(p, LEGACY_MARKER_OC + 'export const AbitoIslandPlugin = async () => ({});\n');
  const pl = plan(p);
  assert.equal(pl.actions[0].action, 'replace', 'the 0.1 marker is ours: it is replaced, not refused');
  assert.ok(pl.after.startsWith(MARKER));
  assert.equal((await applyPlan(pl)).code, 0);
  assert.ok(fs.readFileSync(p, 'utf8').startsWith(MARKER));
  // no marker at all: refused, never overwritten (unchanged behaviour)
  fs.writeFileSync(p, '// somebody else\n');
  assert.throws(() => plan(p), e => e.exitCode === 65);
  assert.equal(fs.readFileSync(p, 'utf8'), '// somebody else\n');
});

test('K2-04: a foreign file at the old name is never retired, and --remove takes the 0.1 plugin out', async t => {
  const dir = plugins(t), old = path.join(dir, OLD_PLUGIN), p = path.join(dir, NEW_PLUGIN);
  fs.writeFileSync(old, '// hand-written by the human\nexport default async () => ({});\n');
  assert.deepEqual(plan(p).retire, [], 'no marker: not ours to retire');
  assert.equal((await applyPlan(plan(p))).code, 0);
  assert.equal(fs.readFileSync(old, 'utf8'), '// hand-written by the human\nexport default async () => ({});\n', 'left byte for byte');
  // remove: the 0.1 plugin (ours, old marker) goes even when the new file is not installed
  const fresh = plugins(t), legacyFile = path.join(fresh, OLD_PLUGIN);
  fs.writeFileSync(legacyFile, LEGACY_MARKER_OC + 'export const AbitoIslandPlugin = async () => ({});\n');
  const rm = plan(path.join(fresh, NEW_PLUGIN), { remove: true });
  assert.equal(rm.retire.length, 1);
  assert.equal((await applyPlan(rm)).code, 0);
  assert.equal(fs.existsSync(legacyFile), false, 'remove takes the 0.1 plugin out');
  assert.equal(fs.existsSync(path.join(fresh, NEW_PLUGIN)), false, 'and creates nothing');
});

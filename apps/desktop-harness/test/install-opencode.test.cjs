'use strict';
const { tmpBase } = require('./platform-env.cjs');
// macOS: tmpBase() is /var/folders/... and /var is a symlink to /private/var; the installers refuse a settings path that contains a
// symlink (correct for a real home), so the fixture home is canonicalized (as the other install tests already do).
// Installer: Abito owns ONE plugin file (~/.config/opencode/plugins/abito-island.js). Never opencode.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planOpencodePlugin, runInstallOpencode, MARKER, STUB, OPENCODE_PROFILE } = require('../src/install-opencode.cjs');

const BIN = '/opt/abito/bin/abito-hook.cjs', NODE = '/usr/bin/node';
const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-ocI-'))); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const plan = (p, o = {}) => planOpencodePlugin({ settingsPath: p, binPath: BIN, execPath: NODE, ...o });

test('a new plugin file carries the ownership marker and the exact deadline', t => {
  const p = path.join(tmp(t), 'abito-island.js'); const pl = plan(p);
  assert.equal(pl.changed, true); assert.equal(pl.exists, false); assert.ok(pl.after.startsWith(MARKER));
  assert.ok(pl.after.includes(JSON.stringify(BIN)) && pl.after.includes(JSON.stringify(NODE)));
  assert.equal(plan(p, { timeoutSec: 60 }).after.includes('60'), true);
});
test('idempotent; a file that is NOT ours is refused, never overwritten; remove leaves an inert stub of ours', t => {
  const d = tmp(t), p = path.join(d, 'abito-island.js');
  fs.writeFileSync(p, plan(p).after); assert.equal(plan(p).changed, false);
  const gone = plan(p, { remove: true }); assert.equal(gone.changed, true); assert.ok(gone.after.startsWith(MARKER)); assert.ok(!gone.after.includes('permission.ask'));
  fs.writeFileSync(p, gone.after); assert.equal(plan(p, { remove: true }).changed, false);
  fs.writeFileSync(p, 'export default async () => ({})\n');
  assert.throws(() => plan(p), e => e.exitCode === 65); assert.throws(() => plan(p, { remove: true }), e => e.exitCode === 65);
  fs.rmSync(p); fs.symlinkSync('/etc/hostname', p); assert.throws(() => plan(p), e => e.exitCode === 65);
  assert.throws(() => plan('rel.js'), e => e.exitCode === 65);
});
test('apply with backup and typed word; the installed file is valid ESM; a wrong word writes nothing', async t => {
  const d = tmp(t), p = path.join(d, 'abito-island.js');
  fs.writeFileSync(p, STUB); // an earlier inert stub of ours
  const stub = fs.readFileSync(p, 'utf8');
  const base = { isTTY: () => true, binPath: BIN, execPath: NODE, out: () => {}, err: () => {}, now: () => new Date('2026-01-02T03:04:05Z') };
  assert.equal(await runInstallOpencode(['opencode', '--settings', p, '--apply'], { ...base, prompt: async () => 'no' }), 1);
  assert.equal(fs.readFileSync(p, 'utf8'), stub);
  assert.equal(await runInstallOpencode(['opencode', '--settings', p, '--apply'], { ...base, prompt: async () => 'install' }), 0);
  const mod = await import(require('node:url').pathToFileURL(p).href + '?v=1'); assert.equal(typeof mod.AbitoIslandPlugin, 'function');
  assert.equal(fs.readdirSync(d).filter(f => f.includes('.abito-backup-')).length, 1);
});
test('profile', () => { assert.equal(OPENCODE_PROFILE.name, 'opencode'); assert.deepEqual(OPENCODE_PROFILE.events, ['permission.ask', 'event']); assert.deepEqual(OPENCODE_PROFILE.defaultFile, ['.config', 'opencode', 'plugins', 'abito-island.js']); });

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wf = require('../src/win-fs.cjs');

const H = 'C:\\Abito\\abito-private-session.exe';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const okFacts = (path, extra = {}) => JSON.stringify({ schema: 'abito-fs/1', ok: true, path, parent_ok: true, exists: true, kind: 'file', reparse: false, private: true, nlink: 1, size: 3, mtime_ms: 5, elevated: false, ...extra });

function fake(handler) {
  const calls = [];
  const exec = (bin, args, opts) => { calls.push({ bin, args, opts }); return handler(args, opts); };
  return { calls, fs: wf.createWinFs({ helper: H, exec }) };
}

test('checkPath calls the helper with a fixed argv, no shell, bounded, and returns closed facts', () => {
  const p = 'C:\\Users\\a\\.claude\\settings.json';
  const { calls, fs } = fake(() => okFacts(p));
  const facts = fs.checkPath(p);
  assert.deepEqual(calls[0].args, ['--check-path', p]);
  assert.equal(calls[0].bin, H);
  assert.equal(calls[0].opts.shell, undefined);
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.maxBuffer <= 65536);
  assert.equal(facts.private, true);
});

test('paths that the helper would refuse never reach it', () => {
  const { calls, fs } = fake(() => okFacts('x'));
  for (const bad of ['rel\\x', '\\\\?\\C:\\x', '\\\\srv\\s\\x', 'C:\\a\\..\\b', 'C:/a/b', 'C:\\a\\b:s']) assert.throws(() => fs.checkPath(bad), /unsafe_path/);
  assert.equal(calls.length, 0);
});

test('helper output must be exactly the closed schema for the requested path', () => {
  const p = 'C:\\Users\\a\\x.json';
  for (const raw of ['', 'not json', JSON.stringify({ schema: 'other' }), okFacts('C:\\other\\y'), okFacts(p, { extra: 1 }), okFacts(p, { private: 'yes' }), okFacts(p) + okFacts(p)]) {
    const { fs } = fake(() => raw);
    assert.throws(() => fs.checkPath(p), /helper/, raw.slice(0, 30));
  }
});

test('a helper refusal (exit 1 with reason JSON) surfaces the fixed reason; garbage becomes helper_failed', () => {
  const p = 'C:\\Users\\a\\x.json';
  const refusing = fake(() => { const e = new Error('x'); e.status = 1; e.stdout = JSON.stringify({ schema: 'abito-fs/1', ok: false, reason: 'not_private' }); throw e; });
  assert.throws(() => refusing.fs.writePrivate(p, Buffer.from('a'), null), e => e.reason === 'not_private');
  const garbage = fake(() => { const e = new Error('x'); e.status = 1; e.stdout = 'whatever C:\\secret'; throw e; });
  assert.throws(() => garbage.fs.checkPath(p), e => e.reason === 'helper_failed' && !/secret/.test(e.message));
});

test('writePrivate sends bytes on stdin only, with --expect none or the sha256', () => {
  const p = 'C:\\Users\\a\\x.json';
  const data = Buffer.from('{"a":1}\n');
  const { calls, fs } = fake(() => JSON.stringify({ schema: 'abito-fs/1', ok: true, sha256: sha(data), size: data.length }));
  fs.writePrivate(p, data, null);
  assert.deepEqual(calls[0].args, ['--write-private', p, '--expect', 'none']);
  assert.ok(Buffer.from(calls[0].opts.input).equals(data));
  fs.writePrivate(p, data, 'a'.repeat(64));
  assert.deepEqual(calls[1].args, ['--write-private', p, '--expect', 'a'.repeat(64)]);
  assert.throws(() => fs.writePrivate(p, data, 'XYZ'), /bad_expect/);
});

test('a write whose reported sha256 differs from our bytes is rejected', () => {
  const { fs } = fake(() => JSON.stringify({ schema: 'abito-fs/1', ok: true, sha256: 'b'.repeat(64), size: 1 }));
  assert.throws(() => fs.writePrivate('C:\\Users\\a\\x.json', Buffer.from('a'), null), /helper/);
});

test('readPrivate refuses foreign, reparse, multi-link, oversized or non-file targets before reading', () => {
  const p = 'C:\\Users\\a\\x.json';
  for (const extra of [{ private: false }, { reparse: true }, { nlink: 2 }, { kind: 'dir' }, { size: 2 * 1024 * 1024 }, { parent_ok: false }]) {
    const { fs } = fake(() => okFacts(p, extra));
    assert.throws(() => fs.readPrivate(p, { readFile: () => assert.fail('must not read') }), /not_private|reparse|too_large/, JSON.stringify(extra));
  }
  const { fs } = fake(() => okFacts(p));
  const got = fs.readPrivate(p, { readFile: () => Buffer.from('abc') });
  assert.equal(got.buf.toString(), 'abc');
  assert.equal(got.sha256, sha(Buffer.from('abc')));
});

test('readPrivate returns null for a missing file under a private parent and refuses a missing/foreign parent', () => {
  const p = 'C:\\Users\\a\\x.json';
  assert.equal(fake(() => okFacts(p, { exists: false, kind: 'none', private: false, nlink: 0, size: 0 })).fs.readPrivate(p), null);
  assert.throws(() => fake(() => okFacts(p, { exists: false, kind: 'none', private: false, parent_ok: false })).fs.readPrivate(p), /not_private/);
});

test('trustedHelper accepts only the receipt-listed sha256 of the sibling helper and a closed manifest', () => {
  const bytes = Buffer.from('MZ-helper');
  const manifest = { schema: 'abito-install/1', files: { 'abito-private-session.exe': sha(bytes), 'desktop-harness/bin/abito-hook.cjs': 'c'.repeat(64) } };
  const deps = { readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : bytes), root: 'C:\\Abito' };
  assert.equal(wf.trustedHelper(deps), 'C:\\Abito\\abito-private-session.exe');
  assert.throws(() => wf.trustedHelper({ ...deps, readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : Buffer.from('tampered')) }), /helper_untrusted/);
  assert.throws(() => wf.trustedHelper({ ...deps, readFile: f => (f.endsWith('.json') ? Buffer.from('{"schema":"x"}') : bytes) }), /helper_untrusted/);
  assert.throws(() => wf.trustedHelper({ ...deps, readFile: () => { throw new Error('ENOENT'); } }), /helper_untrusted/);
  assert.throws(() => wf.trustedHelper({ ...deps, root: 'rel' }), /helper_untrusted/);
});

test('verifyScript checks a registered script against the manifest hash', () => {
  const script = Buffer.from('console.log(1)');
  const manifest = { schema: 'abito-install/1', files: { 'abito-private-session.exe': 'a'.repeat(64), 'desktop-harness/bin/abito-hook.cjs': sha(script) } };
  const deps = { readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : script), root: 'C:\\Abito' };
  assert.doesNotThrow(() => wf.verifyScript('desktop-harness/bin/abito-hook.cjs', deps));
  assert.throws(() => wf.verifyScript('desktop-harness/bin/abito-hook.cjs', { ...deps, readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : Buffer.from('evil')) }), /script_untrusted/);
  assert.throws(() => wf.verifyScript('desktop-harness/bin/unknown.cjs', deps), /script_untrusted/);
});

test('readVerified returns manifest-matching bytes only; verifyBundled maps an absolute script into the install root', () => {
  const script = Buffer.from('hook');
  const manifest = { schema: 'abito-install/1', files: { 'abito-private-session.exe': 'a'.repeat(64), 'desktop-harness/bin/abito-hook.cjs': sha(script) } };
  const deps = { readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : script), root: 'C:\\Abito' };
  assert.ok(wf.readVerified('desktop-harness/bin/abito-hook.cjs', deps).equals(script));
  assert.throws(() => wf.readVerified('desktop-harness/bin/../x', deps), /script_untrusted/);
  assert.doesNotThrow(() => wf.verifyBundled('C:\\Abito\\desktop-harness\\bin\\abito-hook.cjs', deps));
  assert.throws(() => wf.verifyBundled('C:\\Other\\abito-hook.cjs', deps), /script_untrusted/);
});

test('pathOk refuses superscript device names, CONIN$/CONOUT$ and 8.3 short names (verifier L1; mirrors winpolicy::fs_path_ok)', () => {
  for (const bad of ['C:\\a\\COM\u00b9', 'C:\\a\\lpt\u00b2.txt', 'C:\\a\\PROGRA~1\\x', 'C:\\a\\CONIN$', 'C:\\a\\conout$.x']) assert.equal(wf.pathOk(bad), false, bad);
  assert.equal(wf.pathOk('C:\\Users\\a\\.claude\\settings.json'), true);
});

test('M2: the helper is re-verified before EVERY spawn and a failed re-check never executes it', () => {
  const calls = []; let verifies = 0, trusted = true;
  const exec = (bin, args) => { calls.push(args); return JSON.stringify({ schema: 'abito-fs/1', ok: true, path: args[1], parent_ok: true, exists: false, kind: 'none', reparse: false, private: false, nlink: 0, size: 0, mtime_ms: 0, elevated: false }); };
  const w = wf.createWinFs({ helper: H, exec, verify: () => { verifies++; if (!trusted) throw new wf.WinFsError('helper_untrusted'); } });
  w.checkPath('C:\\Users\\a\\x'); w.checkPath('C:\\Users\\a\\y');
  assert.equal(verifies, 2);
  trusted = false;
  assert.throws(() => w.checkPath('C:\\Users\\a\\z'), e => e.reason === 'helper_untrusted');
  assert.equal(calls.length, 2, 'the swapped helper was never executed');
});

test('M2: one resolver — installed sibling only; a dev build is never a candidate unless a test passes dev:true', () => {
  const bytes = Buffer.from('MZ');
  const manifest = { schema: 'abito-install/1', files: { 'abito-private-session.exe': sha(bytes) } };
  const seen = [];
  const deps = { root: 'C:\\Abito', readFile: f => { seen.push(f); if (f.endsWith('.json')) return Buffer.from(JSON.stringify(manifest)); if (f === 'C:\\Abito\\abito-private-session.exe') return bytes; throw new Error('ENOENT'); } };
  assert.equal(wf.resolveHelper(deps), 'C:\\Abito\\abito-private-session.exe');
  assert.ok(seen.every(f => !/target/i.test(f)));
  assert.equal(wf.resolveHelper({ ...deps, readFile: () => { throw new Error('x'); } }), undefined);
  assert.equal(wf.resolveHelper({ ...deps, readFile: f => (f.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : Buffer.from('other')) }), undefined);
  const dev = 'C:\\repo\\desktop-tauri\\target\\debug\\abito-private-session.exe';
  assert.equal(wf.resolveHelper({ ...deps, readFile: f => (f === dev ? bytes : deps.readFile(f)) }), 'C:\\Abito\\abito-private-session.exe');
  assert.equal(wf.resolveHelper({ root: 'C:\\Abito', dev: true, devCandidates: [dev], readFile: f => { if (f.endsWith('.json') || f === 'C:\\Abito\\abito-private-session.exe') throw new Error('absent'); if (f === dev) return bytes; throw new Error('x'); } }), dev);
});

test('L6: the Windows status-line command quotes paths for cmd (double quotes) and refuses unsafe characters', () => {
  assert.equal(wf.quoteWindowsCommandPath('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  for (const bad of ['C:\\a"b\\n.exe', 'C:\\a%PATH%\\n.exe', 'C:\\a\nb', 'rel\\n.exe', "C:\\Users\\O'Neil\\x"]) {
    if (bad.includes("'")) assert.equal(wf.quoteWindowsCommandPath(bad), `"${bad}"`); else assert.throws(() => wf.quoteWindowsCommandPath(bad), /unsafe/);
  }
});

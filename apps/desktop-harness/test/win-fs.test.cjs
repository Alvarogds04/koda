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

// K2-01b: Windows hands out 8.3 short names (%TEMP% is C:\Users\RUNNER~1\... on the CI runner). Each `~` component is
// expanded to the ONE directory entry that is the same file (lstat dev+ino, never following a link); the long path must
// then pass the strict lexical pathOk. pathOk itself stays strict (mirrors winpolicy::fs_path_ok).
// Fake filesystem: path -> {dev, ino, link}; directory listings derived from the keys (long names only, like readdir).
function shortFs(entries) {
  const lower = p => p.toLowerCase();
  const byPath = new Map(Object.entries(entries).map(([p, v]) => [lower(p), v]));
  const aliases = new Map(Object.entries(entries).filter(([, v]) => v.short).map(([p, v]) => [lower(p.slice(0, p.lastIndexOf('\\') + 1) + v.short), v]));
  const lstat = p => {
    const v = byPath.get(lower(p)) || aliases.get(lower(p));
    if (!v) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { dev: v.dev ?? 1n, ino: v.ino, isSymbolicLink: () => v.link === true };
  };
  const readdir = dir => {
    const base = lower(dir.endsWith('\\') ? dir : dir + '\\');
    return Object.keys(entries).filter(p => lower(p).startsWith(base) && !p.slice(base.length).includes('\\')).map(p => p.slice(base.length));
  };
  return { lstat, readdir };
}
const RUNNER = { 'C:\\Users': { ino: 1n }, 'C:\\Users\\runneradmin': { ino: 2n, short: 'RUNNER~1' }, 'C:\\Users\\runnerother': { ino: 3n, short: 'RUNNER~2' },
  'C:\\Users\\runneradmin\\AppData': { ino: 4n } };

test('K2-01b: an 8.3 short component is expanded to its one long name; paths without ~ are returned unchanged', () => {
  const deps = shortFs(RUNNER);
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\abito-x', deps), 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\abito-x');
  assert.equal(wf.longPath('C:\\Users\\RUNNER~2\\x', deps), 'C:\\Users\\runnerother\\x');
  assert.equal(wf.longPath('C:\\Users\\a\\.claude\\settings.json', { lstat: () => assert.fail('no fs for a long path'), readdir: () => assert.fail('no fs') }), 'C:\\Users\\a\\.claude\\settings.json');
});

test('K2-01b: refusals still hold with ~ in the path — lexical rules first, nothing on disk touched', () => {
  const touched = [];
  const deps = { lstat: p => (touched.push(p), shortFs(RUNNER).lstat(p)), readdir: p => (touched.push(p), shortFs(RUNNER).readdir(p)) };
  for (const bad of ['C:\\Users\\RUNNER~1\\..\\..\\Windows', 'C:\\Users\\RUNNER~1\\.\\x', 'C:\\Users\\RUNNER~1\\x:stream', 'C:\\Users\\RUNNER~1\\CON', 'rel\\RUNNER~1',
    '\\\\srv\\s\\RUNNER~1', '\\\\?\\C:\\Users\\RUNNER~1', 'C:/Users/RUNNER~1/x', 'C:\\Users\\RUNNER~1\\x.', 'C:\\Users\\RUNNER~1\\a\x01b', `C:\\Users\\RUNNER~1\\${'a'.repeat(600)}`]) {
    assert.equal(wf.longPath(bad, deps), null, bad);
  }
  assert.deepEqual(touched, []);
});

test('K2-01b: a ~ component that does not exist, matches no entry or several, or is a link/junction is refused', () => {
  // nonexistent: a literal name with ~ stays refused, as before
  assert.equal(wf.longPath('C:\\Users\\NOBODY~1\\x', shortFs(RUNNER)), null);
  // the short name resolves but no long entry has its identity (e.g. vanished between the calls)
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\x', { ...shortFs(RUNNER), readdir: () => ['runnerother'] }), null);
  // two entries with the same identity (hard links): ambiguous
  assert.equal(wf.longPath('C:\\x\\FILE~1.TXT', shortFs({ 'C:\\x': { ino: 9n }, 'C:\\x\\filename.txt': { ino: 7n, short: 'FILE~1.TXT' }, 'C:\\x\\other.txt': { ino: 7n } })), null);
  // a symlink or a junction (Node reports both as symbolic links): refused, never followed nor named
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\x', shortFs({ ...RUNNER, 'C:\\Users\\runneradmin': { ino: 2n, short: 'RUNNER~1', link: true } })), null);
  // a long name that itself contains ~ is still refused by pathOk
  assert.equal(wf.longPath('C:\\a~b\\x', shortFs({ 'C:\\a~b': { ino: 5n } })), null);
  // a file system without file ids (ino 0) cannot prove identity
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\x', shortFs({ 'C:\\Users\\runneradmin': { ino: 0n, short: 'RUNNER~1' } })), null);
  // same ino on another volume is not the same file
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\x', { ...shortFs(RUNNER), lstat: p => (/runneradmin$/i.test(p) ? { dev: 2n, ino: 2n, isSymbolicLink: () => false } : shortFs(RUNNER).lstat(p)) }), null);
});

test('K2-01b: the helper is always given the LONG path, the facts must name it, and an unresolvable ~ never reaches it', () => {
  const calls = [];
  const exec = (bin, args) => { calls.push(args); return okFacts(args[1]); };
  const w = wf.createWinFs({ helper: H, exec, resolve: shortFs(RUNNER) });
  const facts = w.checkPath('C:\\Users\\RUNNER~1\\AppData\\x.json');
  assert.deepEqual(calls[0], ['--check-path', 'C:\\Users\\runneradmin\\AppData\\x.json']);
  assert.equal(facts.path, 'C:\\Users\\runneradmin\\AppData\\x.json');
  w.makeDir('C:\\Users\\RUNNER~1\\AppData\\d');
  w.move('C:\\Users\\RUNNER~1\\a', 'C:\\Users\\RUNNER~2\\b');
  assert.deepEqual(calls.slice(1).map(a => a.slice(1)), [['C:\\Users\\runneradmin\\AppData\\d'], ['C:\\Users\\runneradmin\\a', 'C:\\Users\\runnerother\\b']]);
  const read = []; const r = w.readPrivate('C:\\Users\\RUNNER~1\\AppData\\x.json', { readFile: p => (read.push(p), Buffer.from('abc')) });
  assert.deepEqual(read, ['C:\\Users\\runneradmin\\AppData\\x.json'], 'reads exactly the path the helper checked');
  assert.equal(r.size, 3);
  const n = calls.length;
  assert.throws(() => w.checkPath('C:\\Users\\NOBODY~1\\x'), /unsafe_path/);
  assert.throws(() => w.writePrivate('C:\\Users\\NOBODY~1\\x', 'd', null), /unsafe_path/);
  assert.equal(calls.length, n);
  assert.equal(wf.pathOk('C:\\Users\\RUNNER~1\\x'), false, 'pathOk itself stays strict');
});

test('K2-01b: longPath does NOT vet ancestors — C:\\link\\RUNNER~1 behaves exactly like its long spelling C:\\link\\runneradmin', () => {
  // `link` is a symlink/junction. Only the ~ component is examined (and its own link bit); the non-~ ancestor is never
  // lstat-ed, so the outcome is the long spelling, which pathOk has always accepted: the helper's reparse/parent checks decide.
  const fsx = shortFs({ 'C:\\link': { ino: 8n, link: true }, 'C:\\link\\runneradmin': { ino: 2n, short: 'RUNNER~1' } });
  const seen = []; const deps = { lstat: p => (seen.push(p), fsx.lstat(p)), readdir: fsx.readdir };
  assert.equal(wf.longPath('C:\\link\\RUNNER~1\\x', deps), 'C:\\link\\runneradmin\\x');
  assert.equal(wf.longPath('C:\\link\\runneradmin\\x', deps), wf.pathOk('C:\\link\\runneradmin\\x') ? 'C:\\link\\runneradmin\\x' : null);
  assert.ok(!seen.some(p => p.toLowerCase() === 'c:\\link'), 'the ancestor is not examined by longPath');
  const calls = [];
  const w = wf.createWinFs({ helper: H, exec: (_bin, args) => (calls.push(args), okFacts(args[1], { parent_ok: false })), resolve: fsx });
  assert.equal(w.checkPath('C:\\link\\RUNNER~1\\x').parent_ok, false, 'the helper verdict is what reaches the caller');
  assert.deepEqual(calls[0], ['--check-path', 'C:\\link\\runneradmin\\x']);
});

test('K2-01b: two ~ components are each expanded; a ~ LAST component that is a symlink is refused', () => {
  const two = shortFs({ ...RUNNER, 'C:\\Users\\runneradmin\\AppData\\LongFolderName': { ino: 6n, short: 'LONGFO~1' } });
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\AppData\\LONGFO~1', two), 'C:\\Users\\runneradmin\\AppData\\LongFolderName');
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\AppData\\NOPE~1\\x', two), null, 'the second ~ must also resolve');
  const lastLink = shortFs({ ...RUNNER, 'C:\\Users\\runneradmin\\AppData\\settings-link.json': { ino: 7n, short: 'SETTIN~1.JSO', link: true } });
  assert.equal(wf.longPath('C:\\Users\\RUNNER~1\\AppData\\SETTIN~1.JSO', lastLink), null);
});

test('K2-01b: useForTests accepts a factory, so a test can make active() throw like an untrusted helper', () => {
  let calls = 0;
  wf.useForTests(() => { calls++; throw new wf.WinFsError('helper_untrusted'); });
  try { assert.throws(() => wf.active(), /helper_untrusted/); } finally { wf.useForTests(null); }
  assert.equal(calls, 1);
  const backend = { checkPath() {} };
  wf.useForTests(() => backend);
  try { assert.equal(wf.active(), backend); } finally { wf.useForTests(null); }
});

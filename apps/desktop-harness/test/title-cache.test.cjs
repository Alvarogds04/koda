'use strict';
// HU-062 (found on Windows CI): the Claude session-title cache used process.getuid() and Unix modes, so on Windows no title was ever
// cached (every failure means «no title»). On Windows the private directory and file go through the HU-047 helper backend
// (winfs.active()); this twin drives that path with the same fake backend as win-install-fake.test.cjs, on any OS.
const { test: baseTest } = require('node:test');
// The fake backend judges privacy with POSIX mode bits, which Windows does not have: there the REAL helper is exercised instead by claude-ask.test.cjs («SessionStart caches the title privately…») through assertMode.
const test = (name, ...rest) => baseTest(name, { skip: process.platform === 'win32' && 'fake POSIX backend; real-helper twin: claude-ask.test.cjs SessionStart title cache' }, ...rest);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpBase } = require('./platform-env.cjs');
const winfs = require('../src/win-fs.cjs');
const titles = require('../src/title-cache.cjs');
const { fakeBackend } = require('./win-fake-backend.cjs');

function state(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-title-')));
  fs.chmodSync(d, 0o700);
  t.after(() => { winfs.useForTests(null); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
test('Windows path (helper backend, no getuid): a title is stored privately and read back; a symlink or foreign file is not trusted', t => {
  const dir = state(t), env = { ABITO_STATE_DIR: dir };
  const realUid = process.getuid; process.getuid = undefined; t.after(() => { process.getuid = realUid; });
  winfs.useForTests(fakeBackend());
  assert.equal(titles.saveTitle(env, 'claude-titles', 'tok1', 'Migrar la base'), true);
  assert.equal(titles.loadTitle(env, 'claude-titles', 'tok1'), 'Migrar la base');
  assert.equal(titles.loadTitle(env, 'claude-titles', 'absent'), null);
  const file = path.join(dir, 'claude-titles', 'tok1');
  fs.chmodSync(file, 0o644); // not private any more => not trusted
  assert.equal(titles.loadTitle(env, 'claude-titles', 'tok1'), null);
});
test('Windows path: an untrusted helper means no title, never a crash', t => {
  const dir = state(t), env = { ABITO_STATE_DIR: dir };
  winfs.useForTests({ checkPath() { throw new winfs.WinFsError('helper_untrusted'); }, readPrivate() { throw new winfs.WinFsError('helper_untrusted'); },
    writePrivate() { throw new winfs.WinFsError('helper_untrusted'); }, makeDir() { throw new winfs.WinFsError('helper_untrusted'); } });
  assert.equal(titles.saveTitle(env, 'claude-titles', 'tok1', 'x1'), false);
  assert.equal(titles.loadTitle(env, 'claude-titles', 'tok1'), null);
});
test('default Windows location is %LOCALAPPDATA%\\Abito\\state and the chain below LOCALAPPDATA is created level by level', () => {
  const win = process.platform === 'win32';
  const dir = titles.stateDir({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', HOME: '/h' });
  assert.equal(dir, win ? 'C:\\Users\\dev\\AppData\\Local\\Abito\\state' : '/h/.local/state/abito-island');
});
// Judge recheck warnings (HU-062): the Windows branch must also prune titles older than 14 days (parity with Unix), and a LOCALAPPDATA
// with a trailing separator / forward slashes must still create the chain from it.
test('Windows path prunes titles older than 14 days through the helper, keeps recent ones', t => {
  const dir = state(t), env = { ABITO_STATE_DIR: dir };
  winfs.useForTests(fakeBackend());
  assert.equal(titles.saveTitle(env, 'claude-titles', 'old1', 'Vieja'), true);
  assert.equal(titles.saveTitle(env, 'claude-titles', 'new1', 'Nueva'), true);
  const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, 'claude-titles', 'old1'), old, old);
  assert.equal(titles.saveTitle(env, 'claude-titles', 'new2', 'Otra'), true);
  assert.equal(fs.existsSync(path.join(dir, 'claude-titles', 'old1')), false);
  assert.equal(fs.existsSync(path.join(dir, 'claude-titles', 'new1')), true);
});
test('dirChain starts at LOCALAPPDATA even when it carries a trailing separator or forward slashes', () => {
  const chain = titles.dirChain('C:\\Users\\dev\\AppData\\Local\\Abito\\state\\claude-titles', { LOCALAPPDATA: 'C:/Users/dev/AppData/Local/' });
  assert.deepEqual(chain, ['C:\\Users\\dev\\AppData\\Local\\Abito', 'C:\\Users\\dev\\AppData\\Local\\Abito\\state', 'C:\\Users\\dev\\AppData\\Local\\Abito\\state\\claude-titles']);
});

'use strict';
// macOS has no /proc: the island handoff pid is confirmed with `/bin/ps`. The probe is a verbatim copy of the daemon's
// (procinfo.cjs) because this extension ships alone; these tests pin the copies identical and the fail-closed contract.
// They run on every OS (the parser and the injected exec are pure); the live `ps` check runs where /bin/ps exists
// (Linux and macOS) and Windows has no pid-probe mechanism at all (its twin is the relay, see windows-transport.test.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { darwinProc, resolveConfig } = require('../config.cjs');
const daemon = require('../../desktop-daemon/src/procinfo.cjs');
const harness = require('../../desktop-harness/src/config.cjs');

test('the pid probe is identical in the daemon, desktop-pi and desktop-harness copies', () => {
  // Git may check the files out with CRLF on Windows: compare the code, not the line endings.
  const code = fn => fn.toString().replace(/\r\n/g, '\n');
  for (const name of ['runPs', 'parsePsLine']) {
    assert.equal(code(darwinProc[name]), code(daemon[name]), name);
    assert.equal(code(harness.darwinProc[name]), code(daemon[name]), name);
  }
  assert.equal(darwinProc.PS, '/bin/ps');
  assert.deepEqual(darwinProc.PS_ARGS, daemon.PS_ARGS);
});
test('ps failure or unparseable output means the pid is not confirmed (fail closed)', () => {
  const line = 'Tue Oct 28 12:00:00 2025     1 S      501 /bin/zsh\n';
  assert.deepEqual(darwinProc.parsePsLine(line), { start: String(Math.floor(Date.parse('Tue Oct 28 12:00:00 2025') / 1000)), ppid: 1, state: 'S', uid: 501, command: '/bin/zsh' });
  const seen = [];
  assert.equal(darwinProc.runPs(42, (file, args, opts) => { seen.push([file, args, opts]); return line; }).state, 'S');
  assert.equal(seen[0][0], '/bin/ps'); assert.equal(seen[0][2].timeout, 2000); assert.equal(seen[0][2].env.PATH, '/usr/bin:/bin');
  assert.equal(darwinProc.runPs(42, () => { throw new Error('ENOENT'); }), undefined);
  assert.equal(darwinProc.runPs(42, () => ''), undefined);
  assert.equal(darwinProc.runPs(42, () => 'garbage\n'), undefined);
  assert.equal(darwinProc.runPs(42, () => line + line), undefined);
  assert.equal(darwinProc.runPs(-1, () => line), undefined);
});
test('a live process writing an island-like endpoint.json is discovered (macOS ps probe; Linux /proc; same behaviour)', {
  skip: process.platform === 'win32' && 'Windows resolves the metadata path only; its twin is the handoff test in handoff.test.cjs' }, async t => {
  const { fakeReceiver } = require('./fake-receiver.cjs');
  const rcv = await fakeReceiver(t);
  const file = path.join(rcv.runtime, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid }));
  fs.chmodSync(file, 0o600);
  const options = process.platform === 'darwin' ? { platform: 'darwin' } : {};
  assert.equal(resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime }, process.getuid(), options).endpoint, rcv.endpoint);
  // a pid that does not exist is refused on every Unix
  fs.writeFileSync(file, JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: 2147483646 }));
  assert.equal(resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime }, process.getuid(), options).endpoint, undefined);
});

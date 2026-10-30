'use strict';
// Opt-in end-to-end: the real CLI under a python3 pty (TTY on stdin AND stdout). Temp HOME and settings only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../bin/abito-hook.cjs');
const hasPy = spawnSync('python3', ['-c', 'import pty'], { timeout: 10000 }).status === 0;

const PY = `
import os, pty, select, subprocess, sys, time, json
word = sys.argv[1]; node = sys.argv[2]; env = json.loads(sys.argv[3]); args = sys.argv[4:]
master, slave = pty.openpty()
child = subprocess.Popen([node] + args, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True, start_new_session=True)
os.close(slave)
deadline = time.time() + 10
buf = b''; sent = False; code = None
try:
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try: data = os.read(master, 4096)
            except OSError: data = b''
            if not data and child.poll() is not None: break
            buf += data
            if not sent and b'Type exactly' in buf:
                if word.endswith('^D'): os.write(master, word[:-2].encode() + b'\\x04')
                else: os.write(master, word.encode() + b'\\r')
                sent = True
        if child.poll() is not None and not r: break
    code = child.poll()
finally:
    if child.poll() is None:
        child.kill(); child.wait()
        code = 'timeout'
    os.close(master)
print(json.dumps({'code': code, 'sent': sent}))
`;

function run(word, args, home, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm', ...extraEnv };
  const r = spawnSync('python3', ['-c', PY, word, process.execPath, JSON.stringify(env), BIN, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('pty: the right word writes our entries and a backup; a wrong word changes nothing', { skip: !hasPy && 'python3 missing' }, t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abito-pty-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir, { mode: 0o700 });
  const p = path.join(dir, 'settings.json');
  const orig = '{\n  "n": 12345678901234567890,\n  "a": 1\n}\n';
  fs.writeFileSync(p, orig, { mode: 0o600 });

  let r = run('nope', ['install', 'claude', '--settings', p, '--apply'], home);
  assert.deepEqual(r, { code: 1, sent: true });
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);

  r = run('install', ['install', 'claude', '--settings', p, '--apply'], home);
  assert.deepEqual(r, { code: 0, sent: true });
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.startsWith(orig.slice(0, -3)), 'bytes before hooks identical');
  const parsed = JSON.parse(after);
  assert.ok(parsed.hooks.PermissionRequest && parsed.hooks.Stop);
  assert.ok(after.includes('12345678901234567890'));
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 2);
  assert.ok(names[1].startsWith('settings.json.abito-backup-'));
  assert.equal(fs.readFileSync(path.join(dir, names[1]), 'utf8'), orig);

  r = run('remove', ['install', 'claude', '--user', '--remove', '--apply'], home);
  assert.deepEqual(r, { code: 0, sent: true });
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  assert.ok(fs.readdirSync(dir).every(n => !n.includes('tmp')));
});

test('pty: text then Ctrl-D (no Enter) cannot hang the installer; prompt timeout aborts, nothing written', { skip: !hasPy && 'python3 missing' }, t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abito-pty-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir, { mode: 0o700 });
  const p = path.join(dir, 'settings.json');
  const orig = '{\n  "a": 1\n}\n';
  fs.writeFileSync(p, orig, { mode: 0o600 });
  const r = run('inst^D', ['install', 'claude', '--settings', p, '--apply'], home, { ABITO_INSTALL_PROMPT_TIMEOUT_MS: '300' });
  assert.deepEqual(r, { code: 1, sent: true });
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

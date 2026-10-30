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


test('pty codex: right word writes only the temp hooks.json + backup; wrong word and Ctrl-D write nothing', { skip: !hasPy && 'python3 missing' }, t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abito-ptycodex-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex'); fs.mkdirSync(dir, { mode: 0o700 });
  const p = path.join(dir, 'hooks.json');
  const orig = '{\n  "description": "x",\n  "hooks": {\n    "Stop": [{"hooks": [{"type": "command", "command": "moshi-hook stop"}]}]\n  }\n}\n';
  fs.writeFileSync(p, orig, { mode: 0o600 });
  const base = ['install', 'codex', '--settings', p, '--apply'];

  let r = run('nope', base, home);
  assert.deepEqual(r, { code: 1, sent: true });
  r = run('inst^D', base, home, { ABITO_INSTALL_PROMPT_TIMEOUT_MS: '300' });
  assert.deepEqual(r, { code: 1, sent: true });
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  assert.deepEqual(fs.readdirSync(dir), ['hooks.json']);

  r = run('install', base, home);
  assert.deepEqual(r, { code: 0, sent: true });
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'moshi-hook stop');
  // S4/T2: the notice entries carry no `--timeout-sec` any more (a notice never waits for an answer).
  assert.ok(parsed.hooks.PermissionRequest[0].hooks[0].command.endsWith(' codex permission-request'));
  assert.equal(parsed.hooks.PreToolUse[0].matcher, 'request_user_input');
  assert.ok(parsed.hooks.PreToolUse[0].hooks[0].command.endsWith(' codex pre-tool-use'));
  assert.ok(parsed.hooks.PostToolUse[0].hooks[0].command.endsWith(' codex post-tool-use'), 'the mid-turn clearing entry');
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, names[1]), 'utf8'), orig);
  assert.equal(fs.statSync(path.join(dir, names[1])).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home), ['.codex']);
});

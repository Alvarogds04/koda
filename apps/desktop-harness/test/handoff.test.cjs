'use strict';
const { test: baseTest } = require('node:test');
const { unixTest } = require('./platform-env.cjs');
// The whole file is the Unix handoff (/run/user runtime, socket mode, uid, /proc). Windows twin: windows-transport.test.cjs
// «resolveConfig» win32 cases (LOCALAPPDATA metadata handoff, endpoint shape) and windows verifyEndpoint.
const test = unixTest(baseTest, 'windows-transport.test.cjs win32 config/handoff cases');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveConfig } = require('../src/config.cjs');
const { fakeReceiver } = require('./fake-receiver.cjs');

const owner = process.getuid?.();
const bin = path.resolve(__dirname, '../bin/abito-hook.cjs');
const cwd = path.resolve(__dirname, '..');
const handoff = (rcv, over = {}) => JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid, ...over });
function put(rcv, text, mode = 0o600) {
  const file = path.join(rcv.runtime, 'endpoint.json');
  fs.writeFileSync(file, text); fs.chmodSync(file, mode); return file;
}
const resolve = (rcv, o, uid = owner) => resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime }, uid, o);

// Linux: $XDG_RUNTIME_DIR, else /run/user/<uid>. macOS has neither: the canonical per-user temp dir (src/config.cjs defaultRuntime).
const mac = process.platform === 'darwin';
const macBase = () => fs.realpathSync(require('node:os').tmpdir());
test('default runtime matrix', () => {
  assert.equal(resolveConfig({ ABITO_SOCKET_DIR: '/x/r', XDG_RUNTIME_DIR: '/run/user/9' }, 1, { procExists: () => false }).runtime, '/x/r');
  assert.equal(resolveConfig({ XDG_RUNTIME_DIR: '/tmp/xdg-none' }, 1).runtime, mac ? `${macBase()}/abito-island` : '/tmp/xdg-none/abito-island');
  const fallback = mac ? `${macBase()}/abito-island` : '/run/user/1234/abito-island';
  for (const xdg of [undefined, '', 'rel', '/', '/a/', '/a/../b', '/a\0b'])
    assert.equal(resolveConfig({ XDG_RUNTIME_DIR: xdg }, 1234, { procExists: () => false }).runtime, fallback, String(xdg));
  assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: 'rel' }, 1), /Invalid ABITO_SOCKET_DIR/);
});
test('handoff accepted with a real socket', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, handoff(rcv));
  assert.deepEqual(resolve(rcv), { runtime: rcv.runtime, endpoint: rcv.endpoint, source: 'handoff' });
  assert.equal(resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime }, owner).source, 'handoff');
});
test('Rust producer compact JSON and the alternate compact key order are accepted', async t => {
  const rcv = await fakeReceiver(t, {});
  const producer = `{"endpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid},"v":1}\n`;
  const alternate = `{"v":1,"endpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid}}\n`;
  put(rcv, producer); assert.equal(resolve(rcv).endpoint, rcv.endpoint);
  put(rcv, alternate); assert.equal(resolve(rcv).endpoint, rcv.endpoint);
});
test('handoff rejects noncanonical JSON spellings', async t => {
  const rcv = await fakeReceiver(t, {});
  const body = { v: 1, endpoint: rcv.endpoint, pid: process.pid };
  const bad = [
    `{"v":2,"\\u0076":1,"endpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid}}`,
    `{"v":1,"endpoint":"/wrong/p-abc123/s","\\u0065ndpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid}}`,
    JSON.stringify(body, null, 2), JSON.stringify(body) + '\r\n', ' ' + JSON.stringify(body),
  ];
  const failures = [];
  for (const text of bad) {
    put(rcv, text);
    const endpoint = resolve(rcv).endpoint;
    if (endpoint !== undefined) failures.push({ text, endpoint });
  }
  assert.deepEqual(failures, []);
});
test('handoff requires an exact private single-link file mode', async t => {
  const rcv = await fakeReceiver(t, {});
  const file = path.join(rcv.runtime, 'endpoint.json');
  const failures = [];
  for (const mode of [0o4600, 0o2600, 0o1600, 0o6700, 0o400, 0o640, 0o700]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    put(rcv, handoff(rcv), mode);
    assert.equal(fs.statSync(file).mode & 0o7777, mode, `test mode ${mode.toString(8)} was not applied`);
    const endpoint = resolve(rcv).endpoint;
    if (endpoint !== undefined) failures.push({ mode: mode.toString(8), endpoint });
  }
  put(rcv, handoff(rcv));
  const linked = `${file}.link`;
  fs.linkSync(file, linked);
  try {
    assert.equal(fs.statSync(file).nlink, 2);
    const endpoint = resolve(rcv).endpoint;
    if (endpoint !== undefined) failures.push({ mode: '0600, nlink 2', endpoint });
  } finally { fs.unlinkSync(linked); }
  put(rcv, handoff(rcv), 0o600);
  assert.equal(resolve(rcv).endpoint, rcv.endpoint, 'exact 0600 with one link');
  assert.deepEqual(failures, []);
});
test('handoff verifies endpoint directory chain, socket mode and owner', async t => {
  const rcv = await fakeReceiver(t, {});
  const failures = [];
  const bad = (label, runtime = rcv.runtime) => {
    const endpoint = resolveConfig({ ABITO_SOCKET_DIR: runtime }, owner).endpoint;
    if (endpoint !== undefined) failures.push({ label, endpoint });
  };
  const endpointDir = path.dirname(rcv.endpoint);
  for (const mode of [0o755, 0o777]) {
    fs.chmodSync(endpointDir, mode); put(rcv, handoff(rcv)); bad(`p- directory mode ${mode.toString(8)}`);
    fs.chmodSync(endpointDir, 0o700);
  }
  const linkedDir = path.join(rcv.runtime, 'p-link12');
  fs.symlinkSync(endpointDir, linkedDir);
  put(rcv, handoff(rcv, { endpoint: path.join(linkedDir, 's') }));
  bad('symlinked p- directory'); fs.unlinkSync(linkedDir); put(rcv, handoff(rcv));

  const linkedRuntime = path.join(path.dirname(rcv.runtime), 'runtime-link');
  fs.symlinkSync(rcv.runtime, linkedRuntime);
  const relEndpoint = path.relative(rcv.runtime, rcv.endpoint);
  put(rcv, handoff(rcv, { endpoint: path.join(linkedRuntime, relEndpoint) }));
  bad('symlinked runtime ancestor', linkedRuntime);
  fs.unlinkSync(linkedRuntime); put(rcv, handoff(rcv));

  for (const mode of [0o644, 0o666]) {
    fs.chmodSync(rcv.endpoint, mode); bad(`socket mode ${mode.toString(8)}`);
    fs.chmodSync(rcv.endpoint, 0o600);
  }
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function (target, ...args) {
    const stat = originalLstat.call(this, target, ...args);
    if (target === rcv.endpoint) {
      const spoofed = Object.create(stat);
      Object.defineProperty(spoofed, 'uid', { value: owner + 12345 });
      return spoofed;
    }
    return stat;
  };
  try { bad('socket owned by another uid'); } finally { fs.lstatSync = originalLstat; }
  put(rcv, handoff(rcv)); assert.equal(resolve(rcv).endpoint, rcv.endpoint);
  assert.deepEqual(failures, []);
});
test('pid state rejects zombies and unreadable state, accepts live state and pid 1', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, handoff(rcv));
  const failures = [];
  for (const state of ['Z', 'X', undefined]) {
    const options = { procExists: () => true, procState: () => state };
    const endpoint = resolve(rcv, options).endpoint;
    if (endpoint !== undefined) failures.push({ state, endpoint });
  }
  assert.equal(resolve(rcv, { procExists: () => true, procState: () => 'S' }).endpoint, rcv.endpoint);
  put(rcv, handoff(rcv, { pid: 1 }));
  assert.equal(resolve(rcv, { procExists: pid => pid === 1, procState: pid => pid === 1 ? 'S' : undefined }).endpoint, rcv.endpoint);
  assert.deepEqual(failures, []);
});
test('a real zombie pid is not a live handoff process', async t => {
  const rcv = await fakeReceiver(t, {});
  const child = spawn('python3', ['-c', [
    'import os,signal,time',
    'pid=os.fork()',
    'if pid == 0: os._exit(0)',
    'def stop(sig, frame):',
    ' try: os.waitpid(pid, 0)',
    ' except ChildProcessError: pass',
    ' raise SystemExit(0)',
    'signal.signal(signal.SIGTERM, stop)',
    'print(pid, flush=True)',
    'while True: time.sleep(1)',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
  let zombiePid;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
    if (zombiePid !== undefined) {
      const until = Date.now() + 2000;
      const exists = () => process.platform === 'darwin' ? require('../src/config.cjs').darwinProc.exists(zombiePid) : fs.existsSync(`/proc/${zombiePid}`);
      while (exists() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(exists(), false, 'zombie helper must reap its child before exit');
    }
  });
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('zombie helper did not report a pid')), 3000);
    child.once('error', _error => { clearTimeout(timer); resolve(null); });
    child.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
  });
  if (pid === null) { t.skip('python3 is unavailable for constructing an unreaped child'); return; }
  zombiePid = pid;
  // Linux reads /proc/<pid>/stat; macOS has no /proc, so the same fact comes from the production `ps` probe (config.cjs darwinProc).
  const state = () => {
    if (process.platform === 'darwin') return require('../src/config.cjs').darwinProc.state(pid);
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return raw.slice(raw.lastIndexOf(')') + 1).trimStart()[0];
    } catch { return undefined; }
  };
  const until = Date.now() + 2000;
  while (state() !== 'Z' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state(), 'Z', 'fixture must hold an unreaped zombie');
  put(rcv, handoff(rcv, { pid }));
  assert.equal(resolve(rcv).endpoint, undefined);
});
test('refusals each yield endpoint undefined', async t => {
  const rcv = await fakeReceiver(t, {});
  const file = path.join(rcv.runtime, 'endpoint.json');
  const bad = (label, o, uid) => {
    const r = resolve(rcv, o, uid);
    assert.deepEqual(r, { runtime: rcv.runtime, endpoint: undefined, source: undefined }, label);
  };
  const reset = () => { fs.rmSync(file, { recursive: true, force: true }); };
  bad('missing', undefined);
  const real = put(rcv, handoff(rcv)); fs.renameSync(real, path.join(rcv.runtime, 'valid.json'));
  fs.symlinkSync(path.join(rcv.runtime, 'valid.json'), file); bad('symlink to valid file'); reset();
  fs.symlinkSync('/nonexistent-target', file); bad('dangling symlink'); reset();
  fs.mkdirSync(file); bad('directory'); reset();
  const { execFileSync } = require('node:child_process');
  execFileSync('mkfifo', [file]); bad('fifo'); reset();
  put(rcv, handoff(rcv)); bad('wrong owner', undefined, owner + 1); reset();
  put(rcv, handoff(rcv), 0o644); bad('mode 0644'); reset();
  put(rcv, handoff(rcv) + ' '.repeat(5000)); bad('>4096'); reset();
  const cases = {
    'invalid json': '{nope', 'array': '[1,2,3]', 'null': 'null', 'string': '"x"',
    'extra key': handoff(rcv, { extra: 1 }),
    'missing pid': JSON.stringify({ v: 1, endpoint: rcv.endpoint }),
    'missing v': JSON.stringify({ endpoint: rcv.endpoint, pid: process.pid }),
    'duplicated key': `{"v":1,"v":1,"endpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid}}`,
    'v 2': handoff(rcv, { v: 2 }), 'v string': handoff(rcv, { v: '1' }),
    'pid 0': handoff(rcv, { pid: 0 }), 'pid -1': handoff(rcv, { pid: -1 }), 'pid 1.5': handoff(rcv, { pid: 1.5 }),
    'pid huge': handoff(rcv, { pid: 2 ** 31 }), 'pid string': handoff(rcv, { pid: String(process.pid) }),
    'dead pid': handoff(rcv, { pid: 2147483646 }),
    'relative': handoff(rcv, { endpoint: 'p-abc123/s' }),
    'not under runtime': handoff(rcv, { endpoint: '/tmp/p-abc123/s' }),
    'wrong leaf': handoff(rcv, { endpoint: path.join(path.dirname(rcv.endpoint), 'x') }),
    'wrong depth': handoff(rcv, { endpoint: path.join(path.dirname(rcv.endpoint), 'deeper', 's') }),
    'too long': handoff(rcv, { endpoint: path.join(rcv.runtime, 'p-abc123', 'x'.repeat(120)) }),
    'NUL': handoff(rcv, { endpoint: rcv.endpoint + '\\u0000' }),
    'endpoint number': handoff(rcv, { endpoint: 5 }),
  };
  for (const [label, text] of Object.entries(cases)) { put(rcv, text); bad(label); reset(); }
  // endpoint is a symlink to a socket
  const dir = path.join(rcv.runtime, 'p-abc123'); fs.mkdirSync(dir, { mode: 0o700 });
  fs.symlinkSync(rcv.endpoint, path.join(dir, 's'));
  put(rcv, handoff(rcv, { endpoint: path.join(dir, 's') })); bad('symlink to socket'); reset();
  fs.rmSync(path.join(dir, 's')); fs.writeFileSync(path.join(dir, 's'), 'x');
  put(rcv, handoff(rcv, { endpoint: path.join(dir, 's') })); bad('regular file endpoint'); reset();
  put(rcv, handoff(rcv)); bad('injected dead procExists', { procExists: () => false });
  // sanity: the same file is accepted when everything is right
  assert.equal(resolve(rcv).endpoint, rcv.endpoint);
});
test('refusals never leak file content in errors', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, 'SECRETCONTENT{');
  assert.doesNotThrow(() => resolve(rcv));
});
test('explicit endpoint wins and the handoff is not read', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, handoff(rcv, { endpoint: '/elsewhere/p-abc123/s' }));
  const original = fs.openSync; let opened = 0;
  fs.openSync = (...a) => { opened++; return original(...a); };
  try {
    const r = resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: rcv.endpoint }, owner);
    assert.deepEqual(r, { runtime: rcv.runtime, endpoint: rcv.endpoint, source: 'env' });
  } finally { fs.openSync = original; }
  assert.equal(opened, 0);
  assert.throws(() => resolveConfig({ ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: '/other/p-abc123/s' }, owner), /Unexpected endpoint/);
});
test('stale handoff after socket removal => undefined', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, handoff(rcv));
  assert.equal(resolve(rcv).endpoint, rcv.endpoint);
  fs.unlinkSync(rcv.endpoint);
  assert.equal(resolve(rcv).endpoint, undefined);
});

function run(args, input, env) {
  return new Promise(res => {
    const child = spawn(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, ABITO_SOCKET_DIR: '/nonexistent-abito-test', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c; });
    child.on('close', code => res({ code, stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
test('e2e: hooks need no exported endpoint, only the runtime', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  put(rcv, handoff(rcv));
  const env = { ABITO_SOCKET_DIR: rcv.runtime };
  const stop = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'x' });
  const r1 = await run(['claude', 'stop'], stop, env);
  assert.equal(r1.code, 0);
  await rcv.seen('settled');
  const permission = JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const asked = rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
    sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'allow' } }));
  const r2 = await run(['claude', 'permission-request'], permission, env);
  await asked;
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /allow/);
});
test('e2e: no handoff => unavailable, nothing sent', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await run(['claude', 'stop'], '{}', { ABITO_SOCKET_DIR: rcv.runtime });
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(rcv.frames.length, 0);
  void net;
});

// ---- optional `procStart` identity (the island writes it once WRITE_PROC_START is on; absence stays valid) ----
function ownStart() {
  // field 22 of /proc/<pid>/stat, parsed after the LAST ')' (comm may contain spaces and parentheses)
  // macOS has no /proc: the same identity comes from the production `ps` probe (config.cjs darwinProc, an exact copy of the daemon's).
  if (process.platform === 'darwin') return require('../src/config.cjs').darwinProc.start(process.pid);
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3];
}
test('procStart: absent keeps working; matching accepted; recycled pid or malformed value refused', async t => {
  const rcv = await fakeReceiver(t, {});
  const start = ownStart();
  assert.match(start, /^[0-9]+$/);
  // absent key: unchanged behaviour
  put(rcv, handoff(rcv));
  assert.equal(resolve(rcv).endpoint, rcv.endpoint, 'no procStart');
  // present and equal to this live process: accepted, in both key orders the producers can emit
  put(rcv, handoff(rcv, { procStart: start }));
  assert.deepEqual(resolve(rcv), { runtime: rcv.runtime, endpoint: rcv.endpoint, source: 'handoff' });
  put(rcv, JSON.stringify({ endpoint: rcv.endpoint, pid: process.pid, procStart: start, v: 1 }));
  assert.equal(resolve(rcv).endpoint, rcv.endpoint, 'serde_json key order');
  // present and DIFFERENT = a recycled pid = never connect
  put(rcv, handoff(rcv, { procStart: String(BigInt(start) + 1n) }));
  assert.equal(resolve(rcv).endpoint, undefined, 'different start time');
  // malformed values: not a decimal string
  for (const bad of ['', '0x10', '12 3', '-5', '1.5', ' ' + start, start + ' ', Number(start), null, true, [], {}, 'ab', start + 'x']) {
    put(rcv, handoff(rcv, { procStart: bad }));
    assert.equal(resolve(rcv).endpoint, undefined, `procStart ${JSON.stringify(bad)}`);
  }
  // a duplicate/escaped spelling of the key cannot smuggle a second value (canonical JSON is required)
  put(rcv, `{"v":1,"endpoint":${JSON.stringify(rcv.endpoint)},"pid":${process.pid},"procStart":"1","procSt\\u0061rt":"${start}"}`);
  assert.equal(resolve(rcv).endpoint, undefined, 'duplicate procStart');
  // unknown extra keys stay refused (closed key set)
  put(rcv, handoff(rcv, { procStart: start, extra: 1 }));
  assert.equal(resolve(rcv).endpoint, undefined, 'extra key');
});
test('procStart: unreadable start time of a claimed pid fails closed, injectable for tests', async t => {
  const rcv = await fakeReceiver(t, {});
  put(rcv, handoff(rcv, { procStart: '123456' }));
  assert.equal(resolve(rcv, { procStart: () => '123456' }).endpoint, rcv.endpoint, 'injected matching start');
  assert.equal(resolve(rcv, { procStart: () => '999' }).endpoint, undefined, 'injected different start');
  assert.equal(resolve(rcv, { procStart: () => undefined }).endpoint, undefined, 'unreadable start => refuse');
  // the key is only consulted when present: a handoff without it never calls the reader
  put(rcv, handoff(rcv));
  let called = 0;
  assert.equal(resolve(rcv, { procStart: () => { called++; return undefined; } }).endpoint, rcv.endpoint);
  assert.equal(called, 0);
});
test('procStart: a parent pid that is a different live process is refused (pid reuse)', async t => {
  const rcv = await fakeReceiver(t, {});
  // macOS reads start times with `ps -o lstart=` (1-second resolution): a child started in the same second as this process is
  // indistinguishable. Documented residual (HU-054); the test crosses the second boundary first so it checks the mechanism, not luck.
  if (process.platform === 'darwin') await new Promise(r => setTimeout(r, Math.max(0, 1100 - process.uptime() * 1000)));
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(r => setTimeout(r, 150));
  // the file claims the island's identity (this process) but names the child's pid: start times differ
  put(rcv, handoff(rcv, { pid: child.pid, procStart: ownStart() }));
  assert.equal(resolve(rcv).endpoint, undefined);
  // without the identity key the same file is (by design, residual risk) accepted: pid existence only
  put(rcv, handoff(rcv, { pid: child.pid }));
  assert.equal(resolve(rcv).endpoint, rcv.endpoint);
});

test('procStart: the exact line the Rust producer emits when WRITE_PROC_START is on is accepted', async t => {
  // apps/desktop-tauri/src/handoff.rs `publish` writes serde_json of {"v","endpoint","pid","procStart"} (sorted keys, compact) + "\n"
  const rcv = await fakeReceiver(t, {});
  const line = JSON.stringify({ endpoint: rcv.endpoint, pid: process.pid, procStart: ownStart(), v: 1 }) + '\n';
  put(rcv, line);
  assert.equal(resolve(rcv).endpoint, rcv.endpoint);
  // and the same document pretty-printed or with a CRLF is still refused (canonical compact only)
  put(rcv, JSON.stringify({ v: 1, endpoint: rcv.endpoint, pid: process.pid, procStart: ownStart() }, null, 2));
  assert.equal(resolve(rcv).endpoint, undefined);
  put(rcv, line.replace('\n', '\r\n'));
  assert.equal(resolve(rcv).endpoint, undefined);
});

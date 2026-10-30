'use strict';
// OpenCode permission.ask. The plugin is a thin shim that runs `abito-hook opencode permission-request` (JSON on stdin) and copies
// {"status":"allow"|"deny"} into output.status. Anything else leaves output.status UNTOUCHED, so OpenCode shows its own prompt.
// NOT verified against a real OpenCode (not installed here): payload fields and the permission.ask wiring are from its docs.
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleOpencodeHook: raw_handleOpencodeHook, OC_ALLOW, OC_DENY } = require('../src/opencode.cjs');
const { renderPlugin } = require('../src/install-opencode.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleOpencodeHook = viaPipe(raw_handleOpencodeHook);

const cwd = path.resolve(__dirname, '..');
const perm = (over = {}) => JSON.stringify({ sessionID: 'ses_1', directory: cwd, type: 'bash', title: 'Run: ls', pattern: 'ls', metadata: { command: 'ls' }, ...over });
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
const stub = status => () => ({ ask: async () => ({ status }), notify: async () => ({ status: 'sent' }) });
const call = (input, env, extra = {}) => handleOpencodeHook({ event: 'permission-request', input, env, argv: [], ...extra });

test('allow / deny => exact status line', async t => {
  for (const [value, expected] of [['allow', OC_ALLOW], ['deny', OC_DENY]]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, value);
    const r = await call(perm(), envOf(rcv)); await p;
    assert.equal(r.stdout, expected); assert.equal(r.exitCode, 0);
  }
  assert.deepEqual(JSON.parse(OC_ALLOW), { status: 'allow' }); assert.deepEqual(JSON.parse(OC_DENY), { status: 'deny' });
});
test('the frame names who asks: opencode + project folder', async t => {
  const rcv = await fakeReceiver(t, { questions: true });
  const p = answerer(rcv, 'allow');
  await call(perm(), envOf(rcv)); await p;
  const q = rcv.frames.find(f => f.type === 'question');
  assert.equal(q.agent, 'opencode'); assert.equal(q.projectName, path.basename(cwd));
  assert.equal(q.text, 'OpenCode asks permission: Bash: ls');
});
test('anything but a plain bash command is lossy: allow is not offered', async t => {
  for (const over of [{ type: 'edit', metadata: { filePath: '/x' } }, { type: 'bash', metadata: {} }, { type: 'bash', metadata: { command: 'ls', cwd: '/' } }, { type: 'webfetch', metadata: { url: 'http://x' } }]) {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'terminal');
    const r = await call(perm(over), envOf(rcv)); await p;
    assert.deepEqual(rcv.frames.find(f => f.type === 'question').options.map(o => o.value), ['deny', 'terminal']);
    assert.equal(r.stdout, '');
  }
});
test('every non-answer outcome => EMPTY stdout', async () => {
  for (const s of ['expired', 'busy', 'cancelled', 'human_cancelled', 'unavailable', 'unsupported_receiver', 'protocol_error', 'invalid_request', 'weird']) {
    const r = await call(perm(), stubEndpoint(), { clientFactory: stub(s) });
    assert.equal(r.stdout, '', s); assert.equal(r.exitCode, 0);
  }
  assert.equal((await call(perm(), offlineDir('nonexistent-abito-test'))).stdout, '');
  for (const input of ['garbage', '', perm({ directory: 'rel' }), perm({ sessionID: undefined, type: undefined })]) assert.equal((await call(input, {})).stdout, '');
});

// ---- the generated plugin, run for real against a fake hook binary ----
async function load(t, fakeBody, timeoutSec = 2) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-oc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const bin = path.join(d, 'fake-hook.cjs');
  fs.writeFileSync(bin, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.env.ECHO_IN&&0;${fakeBody}});`);
  const file = path.join(d, 'plugin.mjs');
  fs.writeFileSync(file, renderPlugin({ execPath: process.execPath, binPath: bin, timeoutSec }));
  const mod = await import(require('node:url').pathToFileURL(file).href); // a bare Windows path (C:\...) is not a valid ESM specifier
  return (await mod.AbitoIslandPlugin({ directory: cwd }))['permission.ask'];
}
const ask = async (hook, over = {}) => { const output = { status: 'ask' }; await hook({ id: 'p1', sessionID: 'ses_1', type: 'bash', title: 'Run: ls', pattern: 'ls', metadata: { command: 'ls' }, ...over }, output); return output.status; };

test('plugin: allow / deny from the hook land in output.status; the hook receives the request with the directory', async t => {
  assert.equal(await ask(await load(t, "process.stdout.write('{\"status\":\"allow\"}\\n')")), 'allow');
  assert.equal(await ask(await load(t, "process.stdout.write('{\"status\":\"deny\"}\\n')")), 'deny');
  const echo = await load(t, "const j=JSON.parse(s);process.stdout.write(JSON.stringify({status:j.directory&&j.sessionID==='ses_1'&&j.type==='bash'?'allow':'deny'})+'\\n')");
  assert.equal(await ask(echo), 'allow');
});
test('plugin: empty output, garbage, a forged status, a crash and a hang all leave output.status = ask (OpenCode shows its own prompt)', async t => {
  for (const body of ["", "process.stdout.write('hello')", "process.stdout.write('{\"status\":\"always\"}')", "process.stdout.write('{\"status\":\"ask\"}')", "process.exit(3)", "throw new Error('x')"]) {
    assert.equal(await ask(await load(t, body)), 'ask', body);
  }
  const started = Date.now();
  assert.equal(await ask(await load(t, 'setInterval(()=>{},1000)', 1)), 'ask');
  assert.ok(Date.now() - started < 4000, 'the hang is killed at its own deadline');
});
test('plugin: a throwing environment (no such binary) never throws into OpenCode', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-oc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const file = path.join(d, 'p.mjs'); fs.writeFileSync(file, renderPlugin({ execPath: '/nonexistent/node', binPath: '/nonexistent/bin.cjs', timeoutSec: 2 }));
  const hook = (await (await import(require('node:url').pathToFileURL(file).href)).AbitoIslandPlugin({ directory: cwd }))['permission.ask'];
  assert.equal(await ask(hook), 'ask');
});
test('plugin: session.idle runs the stop hook (a settled notice) and never touches output; other events do nothing', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-oc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const log = path.join(d, 'calls.log'), bin = path.join(d, 'fake.cjs');
  fs.writeFileSync(bin, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(log)},process.argv.slice(2,4).join(' ')+' '+s+'\\n')})`);
  const file = path.join(d, 'p.mjs'); fs.writeFileSync(file, renderPlugin({ execPath: process.execPath, binPath: bin, timeoutSec: 2 }));
  const hooks = await (await import(require('node:url').pathToFileURL(file).href)).AbitoIslandPlugin({ directory: cwd });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  await hooks.event({ event: null });
  await new Promise(r => setTimeout(r, 600));
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.match(lines[0], /^opencode stop /);
  assert.deepEqual(JSON.parse(lines[0].replace(/^opencode stop /, '')), { sessionID: 'ses_1', directory: cwd });
});
test('stop adapter: one settled notice naming opencode + project; no island => nothing', async t => {
  const h = handleOpencodeHook;
  const rcv = await fakeReceiver(t, {});
  const r = await h({ event: 'stop', input: JSON.stringify({ sessionID: 'ses_1', directory: cwd }), env: envOf(rcv), argv: [] });
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
  for (let i = 0; i < 40 && !rcv.frames.some(f => f.type === 'settled'); i++) await new Promise(x => setTimeout(x, 25));
  const n = rcv.frames.find(f => f.type === 'settled'); assert.equal(n.agent, 'opencode'); assert.equal(n.projectName, path.basename(cwd));
  assert.equal((await h({ event: 'stop', input: '{}', env: envOf(rcv), argv: [] })).stdout, '');
});
test('renderPlugin refuses paths that are not plain absolute', () => {
  for (const bad of [{ execPath: 'node' }, { binPath: 'x' }, { execPath: '/a\nb' }, { timeoutSec: 0 }, { timeoutSec: 5000 }]) {
    assert.throws(() => renderPlugin({ execPath: '/usr/bin/node', binPath: '/opt/x.cjs', timeoutSec: 35, ...bad }), /refused|timeout/);
  }
});

// HU-062 (found on Windows CI): opencode.cjs called process.getuid() unguarded (absent on Windows) => «invalid configuration» on every event.
test('a Windows process (no getuid) reaches the island client: ask and stop both work', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), getuid = process.getuid;
  Object.defineProperty(process, 'platform', { value: 'win32' }); process.getuid = undefined;
  t.after(() => { Object.defineProperty(process, 'platform', platform); process.getuid = getuid; });
  const env = { ABITO_DESKTOP_SOCKET: 'C:\\opencode-win\\endpoint.json' };
  let asked = 0, notified = 0;
  const clientFactory = () => ({ ask: async () => { asked++; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; }, notify: async () => { notified++; return { status: 'sent' }; } });
  const r = await handleOpencodeHook({ event: 'permission-request', input: perm(), env, argv: [], clientFactory });
  assert.equal(r.stdout, OC_ALLOW); assert.equal(asked, 1);
  await handleOpencodeHook({ event: 'stop', input: JSON.stringify({ sessionID: 'ses_1', directory: cwd }), env, argv: [], clientFactory });
  assert.equal(notified, 1);
});

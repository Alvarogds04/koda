'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IslandClient, formatNoDecision, createFrameGate, normalizeRequest } = require('../src/client.cjs');
const { projectId, sessionToken } = require('../src/identity.cjs');
const { fakeReceiver, transportOf } = require('./fake-receiver.cjs');

const cwd = path.resolve(__dirname, '..');
const OPTS = [{ value: 'yes', label: 'SECRETLABEL yes', description: '' }, { value: 'no', label: 'No', description: 'd' }];
const TEXT = 'SECRETQUESTION proceed?';

// Real clock except timers >= 30000 ms, which are captured so tests can fire expiry deterministically.
function clock() {
  const long = new Map(); let n = 0;
  return { now: Date.now,
    setTimer: (fn, ms) => { if (ms >= 30000) { const k = ++n; long.set(k, fn); return { long: k }; } return setTimeout(fn, ms); },
    clearTimer: h => { if (h && h.long) long.delete(h.long); else clearTimeout(h); },
    fire: () => { for (const fn of [...long.values()]) fn(); }, pending: () => long.size };
}
async function setup(t, rcv = { questions: true }, extra = {}) {
  const receiver = await fakeReceiver(t, rcv);
  const diagnostics = [];
  const clk = clock();
  const client = new IslandClient({ endpoint: receiver.endpoint, runtime: receiver.runtime, cwd,
    sessionId: 'sess 1', onDiagnostic: d => diagnostics.push(d), clock: clk, ...transportOf(receiver), ...extra });
  return { receiver, client, diagnostics, clk };
}
const scopeOf = () => ({ project: projectId(cwd), sessionId: sessionToken('sess 1') });
const reply = (q, over = {}) => ({ v: 1, type: 'answer', questionVersion: 1, ...scopeOf(), at: Date.now(), id: q.id,
  source: 'human', answer: { type: 'option', value: 'yes' }, ...over });
const closed = (q, over = {}) => ({ v: 1, type: 'question_closed', questionVersion: 1, ...scopeOf(), at: Date.now(),
  id: q.id, source: 'human', reason: 'cancelled', ...over });
const REQ = { text: TEXT, options: OPTS, timeoutMs: 30000 };
async function asking(t, req = REQ, rcv, extra) {
  const s = await setup(t, rcv, extra);
  const qp = s.receiver.next('question');
  const result = s.client.ask(req);
  return { ...s, result, q: await qp };
}
function noLeak(diagnostics) {
  const blob = JSON.stringify(diagnostics);
  assert.doesNotMatch(blob, /SECRET|proceed|yes/);
}

test('notify: hello, ready, one settled frame, then closes', async t => {
  const { receiver, client } = await setup(t, {});
  const settled = receiver.next('settled');
  assert.deepEqual(await client.notify(), { status: 'sent' });
  const s = await settled;
  assert.deepEqual(Object.keys(s).sort(), ['at', 'id', 'project', 'sessionId', 'type', 'v']);
  assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(s.project, projectId(cwd)); assert.equal(s.sessionId, 'sess-1');
  assert.deepEqual(receiver.frames.map(f => f.type), ['hello', 'settled']);
  assert.equal(receiver.rawFrames[0], JSON.stringify({ v: 1, type: 'hello', project: s.project, sessionId: s.sessionId, at: receiver.frames[0].at }) + '\n');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(receiver.clients.size, 0);
});
test('notify with an agent adds exactly projectName + agent (S10 L25); without one the frame is the legacy set', async t => {
  const { receiver, client } = await setup(t, {}, { agent: 'claude-code' });
  const settled = receiver.next('settled');
  assert.deepEqual(await client.notify(), { status: 'sent' });
  const s = await settled;
  assert.deepEqual(Object.keys(s).sort(), ['agent', 'at', 'id', 'project', 'projectName', 'sessionId', 'type', 'v']);
  assert.equal(s.projectName, path.basename(fs.realpathSync(cwd))); assert.equal(s.agent, 'claude-code');
  assert.ok(Buffer.byteLength(receiver.rawFrames.at(-1)) <= 512, 'still a legacy-sized notice frame');
  for (const agent of ['Bad Agent', '', 42, undefined]) {
    const r2 = await setup(t, {}, { agent });
    const p = r2.receiver.next('settled'); await r2.client.notify();
    assert.deepEqual(Object.keys(await p).sort(), ['at', 'id', 'project', 'sessionId', 'type', 'v'], `agent ${String(agent)}`);
  }
});
test('no endpoint / no receiver => unavailable', async t => {
  const { receiver, client } = await setup(t);
  assert.deepEqual(await new IslandClient({ endpoint: undefined, runtime: receiver.runtime, cwd, sessionId: 'x' }).notify(), { status: 'unavailable' });
  assert.deepEqual(await new IslandClient({ endpoint: receiver.runtime + '/p-nope12/s', runtime: receiver.runtime, cwd, sessionId: 'x' }).notify(), { status: 'unavailable' });
  assert.equal((await new IslandClient({ endpoint: receiver.endpoint, runtime: receiver.runtime, cwd: '/no/such/dir', sessionId: 'x' }).notify()).status, 'unavailable');
});
test('old receiver without questions_ready => unsupported_receiver', async t => {
  const { client, diagnostics } = await setup(t, { questions: false }, { handshakeTimeoutMs: 100 });
  const r = await client.ask(REQ);
  assert.deepEqual(r, { status: 'unsupported_receiver' });
  noLeak(diagnostics);
});
test('ask sends questions_hello without busyReason and one question frame of kind question', async t => {
  const { receiver, result, q } = await asking(t);
  const hello = receiver.frames.find(f => f.type === 'questions_hello');
  assert.deepEqual(Object.keys(hello).sort(), ['at', 'project', 'questionVersion', 'sessionId', 'type', 'v']);
  assert.equal(q.kind, 'question'); assert.equal(q.expiresAt, q.at + 30000);
  assert.deepEqual(q.options, OPTS); assert.equal(q.allowFreeText, false);
  assert.equal(receiver.frames.filter(f => f.type === 'question').length, 1);
  receiver.send(reply(q));
  const r = await result;
  assert.deepEqual(r, { status: 'answered', id: q.id, answer: { type: 'option', value: 'yes' } });
  const resolved = await receiver.seen('question_resolved');
  assert.equal(resolved.status, 'answered'); assert.equal(resolved.id, q.id);
});
test('answered free text when allowed', async t => {
  const { receiver, result, q } = await asking(t, { text: TEXT, options: [], allowFreeText: true, timeoutMs: 30000 });
  receiver.send(reply(q, { answer: { type: 'text', text: 'my words' } }));
  assert.deepEqual(await result, { status: 'answered', id: q.id, answer: { type: 'text', text: 'my words' } });
});
test('free text rejected when not allowed => protocol_error, no answer', async t => {
  const { receiver, result, q } = await asking(t);
  receiver.send(reply(q, { answer: { type: 'text', text: 'x' } }));
  assert.equal((await result).status, 'protocol_error');
});
test('expired: producer deadline, cancels with reason expired, no answer', async t => {
  const { receiver, result, q, clk } = await asking(t);
  clk.fire();
  assert.deepEqual(await result, { status: 'expired', id: q.id });
  const c = await receiver.seen('question_cancel');
  assert.equal(c.reason, 'expired'); assert.equal(c.id, q.id);
  assert.equal(clk.pending(), 0);
});
test('human cancel, system cancel and busy map to statuses', async t => {
  let s = await asking(t);
  s.receiver.send(closed(s.q));
  assert.deepEqual(await s.result, { status: 'human_cancelled', id: s.q.id });
  assert.equal((await s.receiver.seen('question_resolved')).status, 'human_cancelled');
  s = await asking(t);
  s.receiver.send(closed(s.q, { source: 'system', reason: 'cancelled' }));
  assert.equal((await s.result).status, 'cancelled');
  s = await asking(t);
  s.receiver.send(closed(s.q, { source: 'system', reason: 'busy' }));
  assert.equal((await s.result).status, 'busy');
});
test('receiver cannot expire early; busyReason never negotiated', async t => {
  let s = await asking(t);
  s.receiver.send(closed(s.q, { source: 'system', reason: 'expired' }));
  assert.equal((await s.result).status, 'protocol_error');
  s = await asking(t);
  s.receiver.send(closed(s.q, { source: 'system', reason: 'busy', busyReason: 'native_transition_busy' }));
  assert.equal((await s.result).status, 'protocol_error');
});
test('invalid receiver frames => protocol_error and never an answer', async t => {
  const cases = {
    wrongId: q => reply(q, { id: '11111111-1111-4111-8111-111111111111' }),
    foreignSession: q => reply(q, { sessionId: 'other' }),
    foreignProject: q => reply(q, { project: 'a'.repeat(64) }),
    extraKeys: q => reply(q, { extra: 1 }),
    staleAt: q => reply(q, { at: q.at - 5000 }),
    oldAt: q => reply(q, { at: Date.now() - 20000 }),
    futureAt: q => reply(q, { at: Date.now() + 60000 }),
    notOffered: q => reply(q, { answer: { type: 'option', value: 'maybe' } }),
    notHuman: q => reply(q, { source: 'system' }),
    badVersion: q => reply(q, { questionVersion: 2 }),
    extraAnswerKey: q => reply(q, { answer: { type: 'option', value: 'yes', x: 1 } }),
    unknownType: q => ({ ...reply(q), type: 'approval_answer' }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const s = await asking(t);
    s.receiver.send(make(s.q));
    const r = await s.result;
    assert.equal(r.status, 'protocol_error', name);
    assert.equal(r.answer, undefined, name);
    assert.equal((await s.receiver.seen('question_cancel')).reason, 'cancelled', name);
    noLeak(s.diagnostics);
  }
});
test('answer stamped a few ms off this process clock (cross-process skew, Windows) is still an answer', async t => {
  for (const skew of [-20, 20]) {
    const s = await asking(t);
    s.receiver.send(reply(s.q, { at: skew < 0 ? s.q.at + skew : Date.now() + 200 }));
    assert.equal((await s.result).status, 'answered', String(skew));
  }
});
test('kind approval or anything else rejected at API boundary; nothing sent', async t => {
  const { receiver, client } = await setup(t);
  for (const kind of ['approval', 'confirm', 1, null]) {
    assert.deepEqual(await client.ask({ ...REQ, kind }), { status: 'invalid_request' });
  }
  assert.equal(receiver.clients.size, 0);
  assert.deepEqual((await client.ask({ ...REQ, kind: 'question', timeoutMs: 1 })), { status: 'invalid_request' });
  for (const bad of [{ ...REQ, options: [OPTS[0]] }, { ...REQ, options: [] }, { ...REQ, options: [OPTS[0], OPTS[0]] },
    { ...REQ, text: '' }, { ...REQ, text: 'x'.repeat(501) }, { ...REQ, extra: 1 }, { ...REQ, options: [...OPTS, ...OPTS, OPTS[0]] },
    { ...REQ, options: [{ ...OPTS[0], label: 'x'.repeat(61) }, OPTS[1]] }, null, 'str']) {
    assert.equal((await client.ask(bad)).status, 'invalid_request');
  }
  assert.equal(receiver.frames.length, 0);
});
test('oversize question frame => invalid_request', async t => {
  const { client, receiver } = await setup(t);
  const options = [0, 1, 2, 3].map(i => ({ value: ('v' + i).padEnd(128, 'a'), label: '😀'.repeat(60), description: '😀'.repeat(160) }));
  assert.equal((await client.ask({ text: '😀'.repeat(500), options, timeoutMs: 30000 })).status, 'invalid_request');
  assert.equal(receiver.frames.length, 0);
});
test('second concurrent ask on same client => busy; first unaffected', async t => {
  const { receiver, client, result, q } = await asking(t);
  assert.deepEqual(await client.ask(REQ), { status: 'busy' });
  receiver.send(reply(q));
  assert.equal((await result).status, 'answered');
  const again = receiver.next('question');
  const second = client.ask(REQ);
  receiver.send(reply(await again));
  assert.equal((await second).status, 'answered');
});
test('socket dropped mid-wait => non-answer unavailable', async t => {
  const { receiver, result, diagnostics } = await asking(t);
  for (const c of receiver.clients) c.destroy();
  const r = await result;
  assert.deepEqual(r, { status: 'unavailable' });
  noLeak(diagnostics);
});
test('oversize inbound buffer and frame floods drop the connection', async t => {
  let s = await asking(t);
  s.receiver.send({ pad: 'x'.repeat(40000) });
  assert.equal((await s.result).status, 'protocol_error');
  s = await asking(t);
  for (const c of s.receiver.clients) c.write('x'.repeat(5000) + '\n');
  assert.equal((await s.result).status, 'protocol_error');
  s = await asking(t);
  const line = JSON.stringify(reply(s.q, { id: '11111111-1111-4111-8111-111111111111' })) + '\n';
  for (const c of s.receiver.clients) c.write(line.repeat(121));
  assert.equal((await s.result).status, 'protocol_error');
  assert.ok(s.diagnostics.length > 0);
});
test('bad ready handshake => unavailable', async t => {
  const { receiver } = await setup(t, {});
  let endpoint, listenOn, extra = {}, runtime = receiver.runtime;
  if (process.platform === 'win32') { // Windows twin: the same misbehaving server on a named pipe + endpoint metadata
    listenOn = `\\\\.\\pipe\\abito-test-bad-${process.pid}-${Date.now()}`;
    runtime = fs.mkdtempSync(path.join(receiver.runtime, 'bad-'));
    endpoint = path.win32.join(runtime, 'endpoint.json');
    fs.writeFileSync(endpoint, JSON.stringify({ v: 1, pipe: listenOn }));
    extra = { platform: 'win32', open: () => net.createConnection(listenOn) };
  } else {
    const dir = fs.mkdtempSync(path.join(receiver.runtime, 'p-'));
    fs.chmodSync(dir, 0o700);
    endpoint = listenOn = path.join(dir, 's');
  }
  const server = net.createServer(sock => { sock.on('error', () => {}); sock.on('data', () => sock.write('{"v":1,"type":"ready","extra":1}\n')); });
  await new Promise(r => server.listen(listenOn, r));
  if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
  t.after(() => server.close());
  const c = new IslandClient({ endpoint, runtime, cwd, sessionId: 'x', ...extra });
  assert.equal((await c.notify()).status, 'unavailable');
  assert.equal((await c.ask(REQ)).status, 'unavailable');
});
test('frame gate allows 120 per minute then refuses; window rolls', () => {
  let now = 0; const gate = createFrameGate(() => now);
  for (let i = 0; i < 120; i++) assert.equal(gate(), true);
  assert.equal(gate(), false);
  now = 60000; assert.equal(gate(), true);
});
test('diagnostics and results never leak question text or labels', async t => {
  const { receiver, result, q, diagnostics } = await asking(t);
  receiver.send(reply(q));
  const r = await result;
  noLeak(diagnostics);
  const msg = formatNoDecision({ status: 'expired', id: q.id, answer: undefined });
  assert.match(msg, /^Koda island: no answer \(expired\)\. Answer in the terminal\./);
  assert.doesNotMatch(msg, /SECRET|yes|[0-9a-f]{8}-/);
  assert.match(formatNoDecision({ status: 'weird' }), /\(error\)/);
  assert.doesNotMatch(JSON.stringify(r.status), /SECRET/);
});
test('child process using the client exits on its own (no timers or sockets left)', async t => {
  const { receiver } = await setup(t);
  receiver.next('question').then(q => receiver.send(reply(q)));
  const script = `
    const { IslandClient } = require(${JSON.stringify(path.resolve(__dirname, '../src/client.cjs'))});
    (async () => {
      const seam = process.env.PIPE ? { platform: 'win32', open: () => require('node:net').createConnection(process.env.PIPE) } : {};
      const c = new IslandClient({ endpoint: process.env.EP, runtime: process.env.RT, cwd: process.env.CWD, sessionId: 'sess 1', ...seam });
      const a = await c.notify();
      const b = await c.ask({ text: 'q?', options: JSON.parse(process.env.OPTS), timeoutMs: 30000 });
      const d = await new IslandClient({ endpoint: undefined, runtime: process.env.RT, cwd: process.env.CWD, sessionId: 'x' }).notify();
      console.log(a.status, b.status, d.status);
    })();`;
  const child = spawn(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, EP: receiver.endpoint, ...(receiver.pipe ? { PIPE: receiver.pipe } : {}), RT: receiver.runtime, CWD: cwd, OPTS: JSON.stringify(OPTS) } });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(kill);
  assert.equal(code, 0);
  assert.equal(out.trim(), 'sent answered unavailable');
});

test('formatNoDecision: every status generic, unknown => generic, never leaks', () => {
  const statuses = ['expired', 'cancelled', 'human_cancelled', 'busy', 'unavailable', 'unsupported_receiver',
    'protocol_error', 'invalid_request', 'disconnected', 'session_changed'];
  for (const status of statuses) {
    const msg = formatNoDecision({ status, id: 'abc-123', text: 'SECRETQUESTION', options: OPTS, path: '/etc/passwd' });
    assert.equal(msg, `Koda island: no answer (${status}). Answer in the terminal.`);
    assert.doesNotMatch(msg, /SECRET|yes|abc-123|\/etc/);
  }
  for (const r of [{ status: 'weird SECRETQUESTION' }, { status: 'answered' }, null, undefined, 'x', {}]) {
    const msg = formatNoDecision(r);
    assert.equal(msg, 'Koda island: no answer (error). Answer in the terminal.');
  }
});
test('normalizeRequest reads each field once; emitted frame equals validated snapshot', async () => {
  const reads = {};
  const flip = (name, first, later) => ({ get() { reads[name] = (reads[name] || 0) + 1; return reads[name] === 1 ? first : later; },
    enumerable: true });
  const option = Object.defineProperties({}, {
    value: flip('value', 'yes', 'bad value!'), label: flip('label', 'Yes', 'L\u202e'),
    description: flip('description', 'd', 'D\u200b') });
  const input = Object.defineProperties({}, {
    text: flip('text', 'Proceed?', 'EVIL\u202e'), options: flip('options', [option, OPTS[1]], []),
    allowFreeText: flip('allowFreeText', false, true), timeoutMs: flip('timeoutMs', 30000, 1),
    kind: flip('kind', 'question', 'approval') });
  const n = normalizeRequest(input);
  assert.deepEqual(n, { text: 'Proceed?', options: [{ value: 'yes', label: 'Yes', description: 'd' }, OPTS[1]],
    allowFreeText: false, timeoutMs: 30000 });
  for (const [k, c] of Object.entries(reads)) assert.equal(c, 1, k);
});
test('bidi/format/C1 in outbound text or label => invalid_request', async t => {
  const { client } = await setup(t);
  for (const bad of [{ ...REQ, text: 'a\u202eb' }, { ...REQ, text: 'a\u200bb' }, { ...REQ, text: 'a\u0085b' },
    { ...REQ, text: 'a\ud800b' }, { ...REQ, options: [{ ...OPTS[0], label: 'x\u2066' }, OPTS[1]] }]) {
    assert.equal((await client.ask(bad)).status, 'invalid_request');
  }
});
test('incoming free-text answer with bidi/format/C1/lone surrogate => protocol_error', async t => {
  for (const bad of ['a\u202eb', 'a\u200bb', 'a\ufeffb', 'a\u0085b', 'a\ud800b']) {
    const { receiver, result, q } = await asking(t, { text: TEXT, options: [], allowFreeText: true, timeoutMs: 30000 });
    receiver.send(reply(q, { answer: { type: 'text', text: bad } }));
    const r = await result;
    assert.equal(r.status, 'protocol_error'); assert.equal(r.answer, undefined);
  }
});
test('emitted question frame equals the validated snapshot (getter flips on 2nd read)', async t => {
  const { receiver, client } = await setup(t);
  let n = 0;
  const input = { options: OPTS, timeoutMs: 30000, get text() { return ++n === 1 ? 'Proceed?' : 'EVIL\u202e'; } };
  const qp = receiver.next('question');
  const result = client.ask(input);
  const q = await qp;
  assert.equal(q.text, 'Proceed?'); assert.equal(n, 1);
  receiver.send(reply(q));
  assert.equal((await result).status, 'answered');
});

test('S3: the question frame names who asks (agent + project name); without an agent it stays unlabelled', async t => {
  const labelled = await asking(t, REQ, { questions: true }, { agent: 'codex' });
  assert.equal(labelled.q.agent, 'codex');
  assert.equal(labelled.q.projectName, require('node:path').basename(cwd));
  labelled.receiver.send(reply(labelled.q)); await labelled.result;
  const plain = await asking(t, REQ, { questions: true }, { agent: undefined });
  assert.equal('agent' in plain.q, false); assert.equal('projectName' in plain.q, false);
  plain.receiver.send(reply(plain.q)); await plain.result;
});

// ---- S4/T2: the «attention» notice (Codex only ever gets a notice, never a question) ----------
test('attention: hello, ready, ONE attention frame (title + detail + who), then closes', async t => {
  const { receiver, client } = await setup(t, {}, { agent: 'codex', projectName: 'my-project' });
  const frame = receiver.next('attention');
  assert.deepEqual(await client.attention({ title: 'Codex te pide permiso', detail: 'Bash: ls · Respondé en la terminal' }),
    { status: 'sent' });
  const a = await frame;
  assert.deepEqual(Object.keys(a).sort(), ['agent', 'at', 'detail', 'id', 'project', 'projectName', 'sessionId', 'title', 'type', 'v']);
  assert.equal(a.v, 1); assert.equal(a.type, 'attention');
  assert.equal(a.title, 'Codex te pide permiso');
  assert.equal(a.detail, 'Bash: ls · Respondé en la terminal');
  assert.equal(a.agent, 'codex'); assert.equal(a.projectName, 'my-project');
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.project, projectId(cwd)); assert.equal(a.sessionId, 'sess-1');
  assert.deepEqual(receiver.frames.map(f => f.type), ['hello', 'attention'], 'no questions_hello for a notice');
  assert.ok(Buffer.byteLength(receiver.rawFrames.at(-1)) <= 512);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(receiver.clients.size, 0);
});
test('attention: without an agent the frame is the legacy notice key set', async t => {
  const { receiver, client } = await setup(t, {});
  const frame = receiver.next('attention');
  await client.attention({ title: 'Codex te pregunta', detail: 'Respondé en la terminal' });
  assert.deepEqual(Object.keys(await frame).sort(), ['at', 'detail', 'id', 'project', 'sessionId', 'title', 'type', 'v']);
});
test('attention: invalid title/detail are refused before any connection', async t => {
  const { client, receiver } = await setup(t);
  for (const bad of [null, 'str', {}, { title: 'Codex' }, { detail: 'Respondé en la terminal' },
    { title: '', detail: 'd' }, { title: '  ', detail: 'd' }, { title: 'Codex', detail: '' },
    { title: 'Codex', detail: 'a\u202eb' }, { title: 'Codex', detail: 'a\u200bb' }, { title: 'Codex', detail: 'a\u0085b' },
    { title: 'Codex', detail: 'line\nbreak' }, { title: 'Codex', detail: 'tab\there' }, { title: 'Codex', detail: 'd\ud800' },
    { title: 'x'.repeat(65), detail: 'd' }, { title: 'Codex', detail: 'd'.repeat(201) },
    { title: 'Codex', detail: 'd', extra: 1 }]) {
    assert.equal((await client.attention(bad)).status, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal(receiver.frames.length, 0);
  assert.equal(receiver.clients.size, 0);
});
test('attention: a pathological session id shrinks the middle, keeps the tail and stays inside 512 bytes', async t => {
  const { receiver } = await setup(t, {}, { agent: 'codex' });
  const client = new IslandClient({ endpoint: receiver.endpoint, runtime: receiver.runtime, cwd,
    sessionId: 's'.repeat(128), agent: 'codex', ...transportOf(receiver) });
  const detail = 'Bash: ' + 'x'.repeat(166) + ' · Respondé en la terminal'; // 199 chars
  assert.deepEqual(await client.attention({ title: 'Codex te pide permiso', detail }), { status: 'sent' });
  const a = await receiver.seen('attention');
  assert.equal(a.sessionId, 's'.repeat(128));
  assert.ok(Buffer.byteLength(receiver.rawFrames.at(-1)) <= 512, 'the notice frame never exceeds the wire cap');
  assert.ok([...a.detail].length < [...detail].length, 'the middle was cut');
  assert.match(a.detail, /Respondé en la terminal$/, 'the actionable tail survives');
});

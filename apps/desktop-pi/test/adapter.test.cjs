'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { registerAdapter } = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');

test('configured fake socket carries exactly legacy v1 lifecycle frames', async t => {
  const receiver = await fakeReceiver(t);
  const { handlers, ctx } = harness(registerAdapter, receiver);
  t.after(() => handlers.get('session_shutdown')());
  assert.equal(receiver.clients.size, 0);
  const hello = receiver.next('hello');
  handlers.get('session_start')({}, ctx);
  const first = await hello;
  assert.deepEqual(Object.keys(first).sort(), ['at', 'project', 'sessionId', 'type', 'v']);
  assert.equal(first.v, 1);
  await receiver.next('heartbeat'); // establishes completed ready handshake
  const settled = receiver.next('settled');
  const unreadable = new Proxy({}, { get() { throw new Error('Never inspect event'); } });
  handlers.get('agent_settled')(unreadable, ctx);
  const event = await settled;
  assert.deepEqual(Object.keys(event).sort(), ['at', 'id', 'project', 'sessionId', 'type', 'v']);
  assert.equal(event.sessionId, first.sessionId);
  handlers.get('session_shutdown')();
  assert.ok(receiver.frames.every(f => ['hello', 'heartbeat', 'settled'].includes(f.type)));
  assert.equal(receiver.frames.filter(f => f.type === 'hello').length, 1);
  assert.equal(receiver.frames.filter(f => f.type === 'settled').length, 1);
  for (let i = 0; i < receiver.frames.length; i++) {
    const f = receiver.frames[i];
    // Same serialization order and newline as the actual legacy adapter.
    const legacy = { v: 1, type: f.type, project: f.project, sessionId: f.sessionId, at: f.at };
    if (f.type === 'settled') legacy.id = f.id;
    assert.equal(receiver.rawFrames[i], JSON.stringify(legacy) + '\n');
  }
});

test('permissions and symlinks fail closed before connecting; no opt-in is inert', async t => {
  const receiver = await fakeReceiver(t);
  // Unix: a world-writable socket is refused. Windows twin of the same behaviour (an endpoint the adapter cannot
  // verify is refused before any connection): metadata that is not the one `endpoint.json` the island publishes.
  if (process.platform === 'win32') receiver.endpoint = require('node:path').win32.join(receiver.runtime, 'other.json');
  else fs.chmodSync(receiver.endpoint, 0o666);
  const { handlers, ctx } = harness(registerAdapter, receiver);
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(receiver.frames.length, 0);
  handlers.get('session_shutdown')();
  const disabled = harness(registerAdapter, { runtime: receiver.runtime });
  disabled.handlers.get('session_start')({}, ctx);
  assert.equal(receiver.clients.size, 0);
});

test('S10 L25: settled stays the exact legacy set at level 0, and carries projectName + agent=pi only after questions_ready', async t => {
  const path = require('node:path');
  const legacy = await fakeReceiver(t);
  const a = harness(registerAdapter, legacy);
  t.after(() => a.handlers.get('session_shutdown')());
  a.handlers.get('session_start')({}, a.ctx);
  await legacy.next('heartbeat');
  const old = legacy.next('settled'); a.handlers.get('agent_settled')({}, a.ctx);
  assert.deepEqual(Object.keys(await old).sort(), ['at', 'id', 'project', 'sessionId', 'type', 'v']);

  const rich = await fakeReceiver(t, { questions: true });
  const b = harness(registerAdapter, { ...rich, questionLevel: 1 });
  t.after(() => b.handlers.get('session_shutdown')());
  b.handlers.get('session_start')({}, b.ctx);
  await rich.next('heartbeat');
  await new Promise(r => setTimeout(r, 150)); // questions_hello went out and the fake receiver answered questions_ready
  const news = rich.next('settled'); b.handlers.get('agent_settled')({}, b.ctx);
  const s = await news;
  assert.deepEqual(Object.keys(s).sort(), ['agent', 'at', 'id', 'project', 'projectName', 'sessionId', 'type', 'v']);
  assert.equal(s.agent, 'pi'); assert.equal(s.projectName, path.basename(path.resolve(__dirname, '..')));
  assert.ok(Buffer.byteLength(rich.rawFrames.at(-1)) <= 512);
});

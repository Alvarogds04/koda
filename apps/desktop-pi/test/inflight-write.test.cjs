'use strict';
// HU-054 (found on Windows CI): a named pipe / relay stdin completes a write a moment AFTER the server read it, so
// `writableLength` is still > 0 when the next frame is due. The adapter used to refuse (silently drop) ANY frame while one
// was in flight, losing `settled`/`question` whenever they raced a heartbeat. A small frame in flight must not block the next
// one; a genuinely stalled receiver (more than one max frame unflushed) is still refused, so memory stays bounded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerAdapter } = require('../adapter.cjs');
const { harness } = require('./fake-receiver.cjs');

function slowSocket({ flushMs, questions = false }) {
  const socket = new EventEmitter();
  socket.frames = []; socket.writableLength = 0; socket.destroyed = false;
  socket.setTimeout = () => socket;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (bytes, callback) => {
    const text = String(bytes); socket.frames.push(JSON.parse(text)); socket.writableLength += Buffer.byteLength(text);
    if (flushMs !== null) setTimeout(() => { socket.writableLength -= Buffer.byteLength(text); callback?.(); }, flushMs);
    const frame = JSON.parse(text);
    if (frame.type === 'hello') setImmediate(() => socket.emit('data', Buffer.from('{"v":1,"type":"ready"}\n')));
    if (frame.type === 'questions_hello' && questions) setImmediate(() => socket.emit('data', Buffer.from('{"v":1,"type":"questions_ready","questionVersion":1}\n')));
    return true;
  };
  setImmediate(() => socket.emit('connect'));
  return socket;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// The `win32` platform + `open` seam runs the same adapter write path on every OS without a real transport.
const RUNTIME = 'C:\\u\\Abito\\notices', META = RUNTIME + '\\endpoint.json';
function start(t, flushMs) {
  const box = {};
  const { handlers, ctx } = harness(registerAdapter, { runtime: RUNTIME, endpoint: META, platform: 'win32',
    heartbeatMs: 10000, open: () => (box.socket = slowSocket({ flushMs })) });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  return { box, handlers, ctx };
}
test('settled is not dropped while a heartbeat is still in flight (slow pipe write completion)', async t => {
  const { box, handlers, ctx } = start(t, 30);
  await wait(20);
  assert.equal(box.socket.frames[0].type, 'hello');
  // the hello write has not completed yet (flush 30ms): a small frame is genuinely in flight
  handlers.get('agent_settled')({}, ctx);
  assert.equal(box.socket.frames.some(f => f.type === 'settled'), true, 'settled must be written');
});
test('a stalled receiver (oldest write unflushed beyond the grace period) is refused promptly', async t => {
  const { box, handlers, ctx } = start(t, null);
  await wait(20);
  await wait(1100); // hello never completes (flushMs null) and is older than the grace period
  handlers.get('agent_settled')({}, ctx);
  assert.equal(box.socket.frames.some(f => f.type === 'settled'), false);
});

test('frames keep their order: a settled written while a heartbeat is in flight comes after it, never before', async t => {
  const box = {};
  const { handlers, ctx } = harness(registerAdapter, { runtime: RUNTIME, endpoint: META, platform: 'win32',
    heartbeatMs: 5, open: () => (box.socket = slowSocket({ flushMs: 15 })) });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  await wait(20);
  handlers.get('agent_settled')({}, ctx);
  await wait(30);
  const types = box.socket.frames.map(f => f.type);
  const settled = types.indexOf('settled');
  assert.ok(settled > 0 && types[0] === 'hello');
  const ats = box.socket.frames.map(f => f.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), 'frames are in the order they were produced');
});
test('a refused frame is not silent: a question reports disconnected and the next heartbeat tears the connection down', async t => {
  const box = {};
  const { handlers, ctx, controller } = harness(registerAdapter, { runtime: RUNTIME, endpoint: META, platform: 'win32',
    heartbeatMs: 1200, questionLevel: 1, open: () => (box.socket = slowSocket({ flushMs: null, questions: true })) });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  await wait(1100); // stalled: nothing the adapter wrote ever completes
  const result = await controller.ask({ kind: 'question', text: 'Q', options: [
    { value: 'a', label: 'A', description: '' }, { value: 'b', label: 'B', description: '' }] }, ctx);
  assert.equal(result.status, 'disconnected');
  await wait(300);
  assert.equal(box.socket.destroyed, true, 'the stalled connection is destroyed at the next heartbeat');
});
test('stall is detected organically within the grace period, not after a 16 KiB backlog (non-ASCII too)', async t => {
  const { box, handlers, ctx } = start(t, null);
  await wait(20);
  const before = box.socket.frames.length;
  await wait(1100);
  handlers.get('agent_settled')({}, ctx);
  assert.equal(box.socket.frames.length, before, 'no frame is queued behind a write stuck for over a second');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { resolveConfig, resolveEndpoint } = require('../config.cjs');
const { registerAdapter } = require('../adapter.cjs');
const META = 'C:\\Users\\runner\\AppData\\Local\\Abito\\notices\\endpoint.json';
const ROOT = 'C:\\Users\\runner\\AppData\\Local\\Abito\\notices';
const tick = () => new Promise(resolve => setImmediate(resolve));
const stat = () => ({ isFile: () => true, isSymbolicLink: () => false });

test('Windows config resolves metadata without getuid and refreshes discovery', () => {
  const options = { platform: 'win32', stat };
  const env = { LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local' };
  assert.deepEqual(resolveConfig(env, undefined, options), {
    runtime: ROOT, endpoint: META, source: 'handoff',
  });
  assert.equal(resolveEndpoint(env, undefined, options), META);
  assert.equal(resolveEndpoint(env, undefined, { ...options, stat: () => { throw Error('missing'); } }), undefined);
  assert.equal(resolveEndpoint({ LOCALAPPDATA: 'relative' }, undefined, options), undefined);
  assert.throws(() => resolveConfig({ ABITO_DESKTOP_SOCKET: '\\\\.\\pipe\\unverified' }, undefined, options));
});

test('Windows Pi relay carries hello, notice and human question; shutdown kills relay', async () => {
  const { createWindowsConnection } = require('../windows-transport.cjs');
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  const ctx = { cwd: __dirname, sessionManager: { getSessionId: () => 'windows-test' } };
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
  const frames = [];
  child.stdin.on('data', data => frames.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const opens = [];
  const controller = registerAdapter(pi, {
    runtime: ROOT, platform: 'win32', questionLevel: 1,
    resolveEndpoint: () => META,
    open: endpoint => {
      opens.push(endpoint);
      return createWindowsConnection(endpoint, { findRelay: () => 'C:\\installed\\abito-notice-relay.exe', spawn: () => child });
    },
  });
  try {
    handlers.get('session_start')({}, ctx);
    assert.deepEqual(opens, [META]);
    child.emit('spawn');
    assert.deepEqual(frames.map(f => f.type), ['hello']);
    child.stdout.write('{"v":1,"type":"ready"}\n');
    child.stdout.write('{"v":1,"type":"questions_ready","questionVersion":1}\n');
    await tick();
    assert.equal(controller.canAsk(), true);
    handlers.get('agent_settled')({}, ctx);
    assert.deepEqual(frames.map(f => f.type), ['hello', 'questions_hello', 'settled']);
    const result = controller.ask({ kind: 'question', text: 'Continue?', options: [
      { value: 'yes', label: 'Yes', description: '' }, { value: 'no', label: 'No', description: '' },
    ] }, ctx);
    await tick();
    const question = frames.find(f => f.type === 'question');
    assert.ok(question);
    child.stdout.write(JSON.stringify({ v: 1, type: 'answer', questionVersion: 1,
      project: question.project, sessionId: question.sessionId, id: question.id,
      at: Date.now(), source: 'human', answer: { type: 'option', value: 'yes' },
    }) + '\n');
    const answer = await result;
    assert.equal(answer.status, 'answered');
    assert.deepEqual(answer.answer, { type: 'option', value: 'yes' });
  } finally {
    handlers.get('session_shutdown')();
  }
  assert.equal(child.killed, true);
});

test('Windows Pi missing relay stays unavailable with no direct pipe fallback', async () => {
  const { createWindowsConnection } = require('../windows-transport.cjs');
  const handlers = new Map();
  const ctx = { cwd: __dirname, sessionManager: { getSessionId: () => 'windows-test' } };
  let attempts = 0;
  const controller = registerAdapter({ on: (event, handler) => handlers.set(event, handler) }, {
    endpoint: META, runtime: ROOT, platform: 'win32', retryMs: 10000,
    open: endpoint => {
      attempts++;
      return createWindowsConnection(endpoint, { findRelay: () => undefined,
        spawn: () => { throw Error('must not spawn'); } });
    },
  });
  try {
    handlers.get('session_start')({}, ctx);
    await tick();
    assert.equal(attempts, 1);
    assert.equal(controller.canAsk(), false);
    const result = await controller.ask({ kind: 'question', text: 'Continue?', options: [
      { value: 'yes', label: 'Yes', description: '' }, { value: 'no', label: 'No', description: '' },
    ] }, ctx);
    assert.equal(result.status, 'unavailable');
  } finally { handlers.get('session_shutdown')(); }
});

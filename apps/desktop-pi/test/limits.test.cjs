'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveQuestionConfig } = require('../config.cjs');
const { normalizeRequest } = require('../questions.cjs');
const { verifyEndpoint } = require('../security.cjs');
const { registerAdapter } = require('../adapter.cjs');
const { fakeReceiver, harness } = require('./fake-receiver.cjs');
const choice = { kind: 'question', text: 'Choose', options: [
  { value: 'one', label: 'One', description: '' }, { value: 'two', label: 'Two', description: '' }], allowFreeText: false };

test('configuration rejects invalid opt-ins and timeout outside bounds', () => {
  // Human, 30-oct («Arreglarlo en Abito: preguntas activadas por defecto»): the extension Abito installs asks the island by
  // default (level 3); Pi needs no environment variable. ABITO_QUESTIONS=0 still turns questions off (notices only).
  assert.deepEqual(resolveQuestionConfig({}), { questionLevel: 3, questionTimeoutMs: 300000 });
  assert.equal(resolveQuestionConfig({ ABITO_QUESTIONS: '0' }).questionLevel, 0);
  assert.equal(resolveQuestionConfig({ ABITO_QUESTIONS: '1', ABITO_QUESTION_TIMEOUT_MS: '30000' }).questionLevel, 1);
  for (const value of ['true', '', '4']) assert.throws(() => resolveQuestionConfig({ ABITO_QUESTIONS: value }));
  for (const value of ['0', '29999', '900001', '1e5', '', 'NaN']) {
    assert.throws(() => resolveQuestionConfig({ ABITO_QUESTION_TIMEOUT_MS: value }));
  }
});
test('choice/text-only/mixed legal; approval exactly two unique tokens, no free text', () => {
  assert.doesNotThrow(() => normalizeRequest(choice));
  assert.doesNotThrow(() => normalizeRequest({ ...choice, allowFreeText: true }));
  assert.doesNotThrow(() => normalizeRequest({ ...choice, options: [], allowFreeText: true }));
  assert.throws(() => normalizeRequest({ ...choice, options: [] }));
  assert.throws(() => normalizeRequest({ ...choice, options: [choice.options[0]] }));
  assert.throws(() => normalizeRequest({ ...choice, options: [choice.options[0], choice.options[0]] }));
  assert.throws(() => normalizeRequest({ ...choice, kind: 'approval', allowFreeText: true }));
  assert.throws(() => normalizeRequest({ ...choice, kind: 'approval', options: [...choice.options,
    { value: 'always', label: 'Always', description: '' }] }));
  assert.throws(() => normalizeRequest({ ...choice, default: 'one' }));
});

test('source symlink is refused even when target is a private socket', async t => {
  const receiver = await fakeReceiver(t);
  if (process.platform === 'win32') {
    // Windows twin: an endpoint that is not directly `<runtime>\\endpoint.json` (a nested/redirected path) is refused.
    assert.throws(() => verifyEndpoint(path.win32.join(receiver.runtime, 'sub', 'endpoint.json'), receiver.runtime));
    return;
  }
  const dir = path.join(receiver.runtime, 'p-symlnk');
  fs.symlinkSync(path.dirname(receiver.endpoint), dir);
  assert.throws(() => verifyEndpoint(path.join(dir, 's'), receiver.runtime));
});

test('missing endpoint or unfinished handshake fails immediately, no question timeout waiting', async t => {
  const receiver = await fakeReceiver(t);
  for (const endpoint of [undefined, path.join(receiver.runtime, 'p-absent', 's'), receiver.endpoint]) {
    const { controller, handlers, ctx } = harness(registerAdapter, { runtime: receiver.runtime,
      endpoint, questionLevel: 1 });
    t.after(() => handlers.get('session_shutdown')());
    handlers.get('session_start')({}, ctx);
    const before = Date.now();
    assert.equal((await controller.ask(choice, ctx)).status, 'unavailable');
    assert.ok(Date.now() - before < 250);
  }
});

test('drop just after opt-in reports unsupported root and never downgrades or reconnects silently', async t => {
  const receiver = await fakeReceiver(t);
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  const { controller, handlers, ctx } = harness(registerAdapter, { ...receiver, questionLevel: 1,
    onTransportError: report });
  t.after(() => handlers.get('session_shutdown')());
  const subscribed = receiver.next('questions_hello'); handlers.get('session_start')({}, ctx);
  await subscribed; for (const c of receiver.clients) c.destroy();
  assert.deepEqual(await reported, { status: 'unsupported_receiver', runtime: receiver.runtime });
  assert.deepEqual(await controller.ask(choice, ctx), { status: 'unsupported_receiver', runtime: receiver.runtime });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(receiver.frames.filter(f => f.type === 'hello').length, 1);
});

test('multibyte answer within 2000 characters can exceed 4096 BYTES and is rejected', async t => {
  const receiver = await fakeReceiver(t, { questions: true });
  const { controller, handlers, ctx } = harness(registerAdapter, { ...receiver, questionLevel: 1 });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx); await receiver.next('heartbeat');
  const frame = receiver.next('question');
  const result = controller.ask({ ...choice, options: [], allowFreeText: true }, ctx);
  const q = await frame;
  const value = { v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId,
    at: Date.now(), id: q.id, source: 'human', answer: { type: 'text', text: '界'.repeat(2000) } };
  assert.equal([...value.answer.text].length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 4096);
  receiver.send(value);
  assert.equal((await result).status, 'protocol_error');
});

// Live bug 30-oct (human's Linux): Abito was restarted to install an update while Pi was open; the old island went away
// between questions_hello and questions_ready, the adapter marked the root «unsupported» and never reconnected, so
// questions stopped reaching the NEW island until Pi was restarted. A NEW endpoint (a restarted island binds a new
// p-XXXXXX/s) is a different receiver and is tried; the SAME endpoint dropping the opt-in stays unsupported (test above).
test('after an unsupported drop, a NEW island endpoint is tried again and questions work', { skip: process.platform === 'win32' && 'Unix endpoint paths; Windows twin: «a restarted island (same endpoint.json path, new pipe inside)»' }, async t => {
  const old = await fakeReceiver(t);
  let current = old.endpoint, report;
  const reported = new Promise(resolve => { report = resolve; });
  const { controller, handlers, ctx } = harness(registerAdapter, { runtime: old.runtime, questionLevel: 1,
    resolveEndpoint: () => current, onTransportError: report });
  t.after(() => handlers.get('session_shutdown')());
  const subscribed = old.next('questions_hello'); handlers.get('session_start')({}, ctx);
  await subscribed; for (const c of old.clients) c.destroy();
  assert.equal((await reported).status, 'unsupported_receiver');
  const fresh = await fakeReceiver(t, { questions: true, runtime: old.runtime });
  const hello = fresh.next('questions_hello');
  current = fresh.endpoint;
  await hello;
  for (let i = 0; i < 100 && !controller.canAsk(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.canAsk(), true, 'questions reach the restarted island without restarting Pi');
  assert.equal(old.frames.filter(f => f.type === 'hello').length, 1, 'the old endpoint is not retried');
});

test('Windows: a restarted island (same endpoint.json path, new pipe inside) is tried again', async t => {
  // The Windows endpoint file never moves; only its content (the pipe) changes on restart. Exercised through the public
  // adapter with an injected win32 connection, so it runs on every OS (the native relay is covered by the Windows CI).
  const { EventEmitter } = require('node:events');
  const runtime = 'C:\\Users\\t\\AppData\\Local\\Abito\\notices', endpoint = runtime + '\\endpoint.json';
  let content = JSON.stringify({ v: 1, pipe: 'abito-' + 'a'.repeat(32) });
  const opened = [];
  const open = () => { const c = new EventEmitter(); Object.assign(c, { destroyed: false, setTimeout() {}, write(b, cb) { if (String(b).includes('questions_hello')) setImmediate(() => c.destroy()); cb?.(); return true; },
    destroy() { if (!c.destroyed) { c.destroyed = true; setImmediate(() => c.emit('close')); } } });
    opened.push(c); setImmediate(() => { c.emit('connect'); c.emit('data', Buffer.from('{"v":1,"type":"ready"}\n')); }); return c; };
  let report; const reported = new Promise(resolve => { report = resolve; });
  const { handlers, ctx } = harness(registerAdapter, { runtime, questionLevel: 1, platform: 'win32', open, resolveEndpoint: () => endpoint, readFile: () => content, onTransportError: report });
  t.after(() => handlers.get('session_shutdown')());
  handlers.get('session_start')({}, ctx);
  assert.equal((await reported).status, 'unsupported_receiver');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(opened.length, 1, 'the same island is not retried');
  content = JSON.stringify({ v: 1, pipe: 'abito-' + 'b'.repeat(32) });
  for (let i = 0; i < 50 && opened.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened.length >= 2, 'a new pipe in endpoint.json is a new island and is tried');
});


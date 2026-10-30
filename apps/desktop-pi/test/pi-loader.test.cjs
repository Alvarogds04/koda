'use strict';
// Offline real loader verification. No Pi session, models, auth or ambient extensions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { windowsTwin } = require('./windows-real-pi.cjs');
const { fakeReceiver } = require('./fake-receiver.cjs');
function findPi() {
  if (process.env.PI_CODING_AGENT_ROOT) return process.env.PI_CODING_AGENT_ROOT;
  const marker = '/@earendil-works/pi-coding-agent/';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try { const real = fs.realpathSync(path.join(dir, 'pi'));
      const i = real.indexOf(marker); if (i >= 0) return real.slice(0, i + marker.length - 1);
    } catch { /* read-only discovery */ }
  }
}
test('actual Pi loader exposes model-only abito_ask and returns the human reply as its tool result', async t => {
  const root = findPi();
  if (!root) { t.skip('Installed Pi not found; set PI_CODING_AGENT_ROOT'); return; }
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true });
  if (process.platform === 'win32') return windowsTwin(t, root, receiver); // Windows twin: see windows-real-pi.cjs
  const vars = ['ABITO_SOCKET_DIR', 'ABITO_DESKTOP_SOCKET', 'ABITO_QUESTIONS', 'ABITO_QUESTION_TIMEOUT_MS'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of vars) {
    if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
  } });
  Object.assign(process.env, { ABITO_SOCKET_DIR: receiver.runtime, ABITO_DESKTOP_SOCKET: receiver.endpoint,
    ABITO_QUESTIONS: '2', ABITO_QUESTION_TIMEOUT_MS: '300000' });
  const loader = await import(pathToFileURL(path.join(root, 'dist/core/extensions/loader.js')));
  const { extensions, errors, warnings } = await loader.loadExtensions([
    path.resolve(__dirname, '../pi-extension.ts')], path.resolve(__dirname, '..'),
    { on: () => () => {}, emit: () => {} }, loader.createExtensionRuntime());
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  assert.equal(extensions.length, 1);
  const ext = extensions[0];
  const ctx = { cwd: path.resolve(__dirname, '..'), hasUI: false,
    sessionManager: { getSessionId: () => 'real-loader-session' } };
  t.after(async () => { for (const fn of ext.handlers.get('session_shutdown')) await fn({}, ctx); });
  const subscribed = receiver.next('questions_hello');
  for (const fn of ext.handlers.get('session_start')) await fn({}, ctx);
  await subscribed;
  // Handshake acceptance may still be queued; wait for a settled notice, not a model.
  const ready = new Promise(resolve => setTimeout(resolve, 20)); await ready;
  const entry = ext.tools.get('abito_ask');
  const tool = entry.definition ?? entry;
  assert.equal(tool.exposure, 'model-only');
  assert.match(tool.description, /normal chat/);
  assert.equal(ext.tools.size, 1);
  assert.equal(ext.commands.size, 0);
  const frame = receiver.next('question');
  const result = tool.execute('call-1', { kind: 'approval', text: 'Proceed?', options: [
    { value: 'allow-once', label: 'Allow once', description: '' },
    { value: 'deny', label: 'Deny', description: '' }], allowFreeText: false }, new AbortController().signal, () => {}, ctx);
  const q = await frame;
  const ack = receiver.next('question_resolved');
  receiver.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId,
    at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'deny' } });
  const returned = await result;
  assert.equal(returned.isError, false);
  assert.deepEqual(returned.details, { status: 'answered', id: q.id, answer: { type: 'option', value: 'deny' } });
  assert.deepEqual(JSON.parse(returned.content[0].text), returned.details);
  assert.equal((await ack).status, 'answered');
  for (const code of ['native_transition_busy', 'native_transition_degraded']) {
    const frame = receiver.next('question');
    const pending = tool.execute('call-busy', { kind: 'question', text: 'Input?', options: [],
      allowFreeText: true }, new AbortController().signal, () => {}, ctx);
    const q = await frame;
    receiver.send({ v: 1, type: 'question_closed', questionVersion: 1, project: q.project,
      sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'system', reason: 'busy', busyReason: code });
    const returned = await pending;
    assert.deepEqual(returned.details, { status: 'busy', id: q.id, reasonCode: code });
    assert.equal(returned.isError, true);
    assert.match(returned.content[0].text, /Ask through normal chat/);
    assert.match(returned.content[0].text, code === 'native_transition_busy' ? /adjusting its window/ : /cannot verify its window size/);
  }
  const invalidFrame = receiver.next('question');
  const invalid = tool.execute('call-invalid', { kind: 'question', text: 'Input?', options: [],
    allowFreeText: true }, new AbortController().signal, () => {}, ctx);
  const qBad = await invalidFrame;
  receiver.send({ v: 1, type: 'question_closed', questionVersion: 1, project: qBad.project,
    sessionId: qBad.sessionId, at: Date.now(), id: qBad.id, source: 'human', reason: 'cancelled',
    busyReason: 'native_transition_busy' });
  const failure = await invalid;
  assert.equal(failure.details.status, 'protocol_error');
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /protocol error.*pending call ended immediately/);
  assert.match(failure.content[0].text, /Ask through normal chat/);
});

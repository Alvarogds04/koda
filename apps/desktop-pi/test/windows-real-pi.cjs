'use strict';
// Windows twin of the two real-Pi loader tests (pi-loader, pi-confirm). On win32 the REAL extension never opens the island's pipe:
// it spawns the native relay `abito-notice-relay.exe` from fixed locations, and the hosted runner has none installed. What exists
// on every OS without a relay, and is asserted here against the real Pi loader: the extension loads without errors, registers the
// model-only `abito_ask`, and FAILS CLOSED (status `unavailable`) with no direct connection to the pipe. The Pi -> real relay -> pipe
// end-to-end on Windows is a registered gap (HU-054 follow-up: the Windows smoke installs the real relay and has to drive a Pi session).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function windowsTwin(t, root, receiver, { extra = [] } = {}) {
  const vars = ['ABITO_SOCKET_DIR', 'ABITO_DESKTOP_SOCKET', 'ABITO_QUESTIONS', 'ABITO_QUESTION_TIMEOUT_MS'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of vars) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
  // the metadata path IS valid, so the adapter reaches the relay step; no relay exists, so it must fail closed
  Object.assign(process.env, { ABITO_DESKTOP_SOCKET: receiver.endpoint, ABITO_QUESTIONS: '2', ABITO_QUESTION_TIMEOUT_MS: '300000' });
  delete process.env.ABITO_SOCKET_DIR;
  const loader = await import(pathToFileURL(path.join(root, 'dist/core/extensions/loader.js')));
  const { extensions, errors } = await loader.loadExtensions([path.resolve(__dirname, '../pi-extension.ts'), ...extra],
    path.resolve(__dirname, '..'), { on: () => () => {}, emit: () => {} }, loader.createExtensionRuntime());
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1 + extra.length);
  const ext = extensions[0];
  const ctx = { cwd: path.resolve(__dirname, '..'), hasUI: false, sessionManager: { getSessionId: () => 'win-real-loader' } };
  t.after(async () => { for (const fn of ext.handlers.get('session_shutdown') ?? []) await fn({}, ctx); });
  for (const fn of ext.handlers.get('session_start')) await fn({}, ctx);
  const entry = ext.tools.get('abito_ask');
  const tool = entry.definition ?? entry;
  assert.equal(tool.exposure, 'model-only');
  const result = await tool.execute('call-win', { kind: 'question', text: 'Input?', options: [], allowFreeText: true },
    new AbortController().signal, () => {}, ctx);
  assert.equal(result.details.status, 'unavailable', 'no relay: the question fails closed instead of waiting');
  assert.equal(receiver.clients.size, 0, 'no direct connection to the pipe');
  assert.equal(receiver.frames.length, 0);
}
module.exports = { windowsTwin };

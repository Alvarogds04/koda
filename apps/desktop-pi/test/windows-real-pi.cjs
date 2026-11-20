'use strict';
// Windows twin of the real-Pi loader tests (pi-loader, pi-confirm). On win32 the REAL extension never opens the island's pipe:
// it spawns the native relay `abito-notice-relay.exe` from fixed locations, and the hosted runner has none installed. What exists
// on every OS without a relay, and is asserted here against the real Pi loader: the extension loads without errors, registers NO
// tool of its own (K3-04: `abito_ask` is gone; every question uses Pi's generic mechanism), keeps Pi's own `ctx.ui.confirm`
// routed, never blocks a native ask it cannot answer, and contacts nothing. The Pi -> real relay -> pipe end-to-end on Windows is
// a registered gap (HU-054 follow-up: the Windows smoke installs the real relay and has to drive a Pi session).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function windowsTwin(t, root, receiver, { extra = [] } = {}) {
  const vars = ['KODA_SOCKET_DIR', 'KODA_DESKTOP_SOCKET', 'KODA_QUESTIONS', 'KODA_QUESTION_TIMEOUT_MS'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of vars) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
  // the metadata path IS valid, so the adapter reaches the relay step; no relay exists, so it must fail closed
  Object.assign(process.env, { KODA_DESKTOP_SOCKET: receiver.endpoint, KODA_QUESTIONS: '2', KODA_QUESTION_TIMEOUT_MS: '300000' });
  delete process.env.KODA_SOCKET_DIR;
  const loader = await import(pathToFileURL(path.join(root, 'dist/core/extensions/loader.js')));
  const { extensions, errors } = await loader.loadExtensions([path.resolve(__dirname, '../pi-extension.ts'), ...extra],
    path.resolve(__dirname, '..'), { on: () => () => {}, emit: () => {} }, loader.createExtensionRuntime());
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1 + extra.length);
  const ext = extensions[0];
  assert.equal(ext.tools.size, 0, 'no tool of its own is registered');
  assert.equal(ext.tools.has('abito_ask'), false);
  const confirmCalls = [];
  const ui = {
    confirm: (title, message, opts) => { confirmCalls.push({ title, message, opts }); return Promise.resolve(true); },
    select: (title, options, opts) => new Promise(resolve => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true })),
    input: (title, placeholder, opts) => new Promise(resolve => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true })),
    notify: () => {},
  };
  const original = ui.confirm;
  const ctx = { cwd: path.resolve(__dirname, '..'), hasUI: true, ui, sessionManager: { getSessionId: () => 'win-real-loader' } };
  t.after(async () => { for (const fn of ext.handlers.get('session_shutdown') ?? []) await fn({}, ctx); });
  for (const fn of ext.handlers.get('session_start')) await fn({}, ctx);
  // Pi's generic confirm stays routed, and without a relay it is terminal-only (never approval by silence).
  assert.notEqual(ui.confirm, original, 'ctx.ui.confirm is routed by the extension');
  assert.equal(await ui.confirm('Allow guarded forced git branch deletion?', 'git branch -D feature/old-spike'), true);
  assert.equal(confirmCalls.length, 1);
  // No relay: a native ask is never blocked, so Pi's own tool runs exactly as it would without the extension.
  for (const fn of ext.handlers.get('tool_call')) {
    assert.equal(await fn({ type: 'tool_call', toolName: 'ask_user_choice', toolCallId: 't-win',
      input: { question: 'Which route?', options: [{ label: 'Alpha', description: '', value: 'val-alpha' }] } }, ctx), undefined);
  }
  assert.equal(receiver.clients.size, 0, 'no direct connection to the pipe');
  assert.equal(receiver.frames.length, 0);
}
module.exports = { windowsTwin };

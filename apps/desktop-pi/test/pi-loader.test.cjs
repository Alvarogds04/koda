'use strict';
// Offline real loader verification. No Pi session, models, auth or ambient extensions.
// K3-04: the extension registers NO tool of its own (`abito_ask` is gone; the human's permanent requirement is that
// every question uses the agent's GENERIC mechanism). What must keep working is the generic path: Pi's own
// `ask_user_choice` / `ask_user_question` (native-ask) and `ctx.ui.confirm` are answerable from the island.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { windowsTwin } = require('./windows-real-pi.cjs');
const { fakeReceiver } = require('./fake-receiver.cjs');
const EXTENSION = path.resolve(__dirname, '../pi-extension.ts');
const CWD = path.resolve(__dirname, '..');
function findPi() {
  if (process.env.PI_CODING_AGENT_ROOT) return process.env.PI_CODING_AGENT_ROOT;
  const marker = '/@earendil-works/pi-coding-agent/';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try { const real = fs.realpathSync(path.join(dir, 'pi'));
      const i = real.indexOf(marker); if (i >= 0) return real.slice(0, i + marker.length - 1);
    } catch { /* read-only discovery */ }
  }
}
// The terminal Pi would show: `select`/`input` resolve only when the dialog is aborted, `confirm` on demand.
function terminalUI() {
  const calls = { confirm: [], select: [], input: [], notes: [] };
  const dialog = (list, placeholder) => (title, options, opts) => new Promise(resolve => {
    list.push({ title, options: placeholder === undefined ? options : [placeholder], opts });
    opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const ui = {
    confirm: (title, message, opts) => { calls.confirm.push({ title, message, opts }); return Promise.resolve(true); },
    select: dialog(calls.select), input: (title, placeholder, opts) => dialog(calls.input)('ignored', title, placeholder, opts),
    notify: (message, type) => calls.notes.push([message, type]),
  };
  return { ui, calls };
}

// K3-04: no tool of its own exists. This guard needs no installed Pi (this Node build has no TypeScript support:
// `ERR_NO_TYPESCRIPT`), so it reads the module that Pi loads and pins the registrations it may make. The loaded,
// behavioural proof is the next test, through Pi's real extension loader.
test('the extension module registers no tool of its own: abito_ask is gone and only Pi generic hooks remain', () => {
  const source = fs.readFileSync(EXTENSION, 'utf8');
  assert.doesNotMatch(source, /registerTool/, 'no model-facing tool: every question uses the agent generic mechanism');
  assert.doesNotMatch(source, /defineTool/);
  assert.doesNotMatch(source, /name:\s*['"]abito_ask['"]/, 'abito_ask is never registered');
  assert.doesNotMatch(source, /ask-tool\.cjs/, 'the removed tool module is not imported');
  for (const hook of ["pi.on('tool_call'", "pi.on('session_start'", "pi.on('session_shutdown'"]) {
    assert.ok(source.includes(hook), `${hook} is the generic intercept, not a tool`);
  }
  assert.equal(fs.existsSync(path.join(__dirname, '../ask-tool.cjs')), false, 'the custom ask tool is deleted');
  assert.equal(fs.existsSync(path.join(__dirname, 'ask-tool.test.cjs')), false);
});

test('real Pi loader: no tool is registered and Pi\'s own native ask is still answered from the island', async t => {
  const root = findPi();
  if (!root) { t.skip('Installed Pi not found; set PI_CODING_AGENT_ROOT'); return; }
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true });
  if (process.platform === 'win32') return windowsTwin(t, root, receiver); // Windows twin: see windows-real-pi.cjs
  const vars = ['KODA_SOCKET_DIR', 'KODA_DESKTOP_SOCKET', 'KODA_QUESTIONS', 'KODA_QUESTION_TIMEOUT_MS',
    'KODA_NATIVE_ASK', 'KODA_NATIVE_CONFIRM'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of vars) {
    if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
  } });
  for (const k of vars) delete process.env[k];
  Object.assign(process.env, { KODA_SOCKET_DIR: receiver.runtime, KODA_DESKTOP_SOCKET: receiver.endpoint,
    KODA_QUESTIONS: '2', KODA_QUESTION_TIMEOUT_MS: '300000' });
  const loader = await import(pathToFileURL(path.join(root, 'dist/core/extensions/loader.js')));
  const { extensions, errors, warnings } = await loader.loadExtensions([EXTENSION], CWD,
    { on: () => () => {}, emit: () => {} }, loader.createExtensionRuntime());
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  assert.equal(extensions.length, 1);
  const ext = extensions[0];
  assert.deepEqual([...ext.tools.keys()], [], 'the loaded extension registers no tool at all');
  assert.equal(ext.tools.has('abito_ask'), false, 'abito_ask does not exist');
  assert.equal(ext.commands.size, 0);

  const { ui, calls } = terminalUI();
  const ctx = { cwd: CWD, hasUI: true, ui, sessionManager: { getSessionId: () => 'real-loader-session' } };
  t.after(async () => { for (const fn of ext.handlers.get('session_shutdown') ?? []) await fn({}, ctx); });
  const subscribed = receiver.next('questions_hello');
  for (const fn of ext.handlers.get('session_start')) await fn({}, ctx);
  await subscribed;
  // The capability reply may still be queued: the generic path asks only when the receiver speaks QP/1.
  await new Promise(resolve => setTimeout(resolve, 20));

  // Pi's own ask_user_choice: ONE uuid from the island, the terminal dialog withdrawn, exactly the native text back.
  const frame = receiver.next('question');
  const blocked = (async () => {
    for (const fn of ext.handlers.get('tool_call')) {
      const result = await fn({ type: 'tool_call', toolName: 'ask_user_choice', toolCallId: 't1',
        input: { question: 'Which route?', options: [
          { label: 'Alpha', description: 'First one', value: 'val-alpha' },
          { label: 'Beta', description: '', value: 'val-beta' }] } }, ctx);
      if (result) return result;
    }
  })();
  const q = await frame;
  assert.equal(q.kind, 'question');
  assert.equal(q.text, 'Which route?');
  receiver.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId,
    at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'o2' } });
  assert.deepEqual(await blocked, { block: true, reason: 'User selected: 2. Beta (value: val-beta)' });
  assert.equal(calls.select.length, 1, 'the terminal asks too');
  assert.equal(calls.select[0].opts.signal.aborted, true, 'answered in Koda: the terminal dialog is withdrawn');
});

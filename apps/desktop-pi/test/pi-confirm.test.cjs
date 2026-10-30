'use strict';
// HU-042 pin against the REAL Pi extension runner (offline: no session, model, auth or ambient extensions).
// A second, stand-in extension plays gentle-pi's bash guard: on `tool_call` it asks `ctx.ui.confirm(...)` exactly like
// gentle-ai.ts:2156 and blocks unless the answer is === true. The Abito extension must make that confirm answerable
// from the island (first answer wins), keep the terminal confirm, never route a sensitive one, and unwrap on shutdown.
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

test('real Pi runner: a guarded-command confirm is answerable from Abito; sensitive ones stay in the terminal; unwrap on shutdown', async t => {
  const root = findPi();
  if (!root) { t.skip('Installed Pi not found; set PI_CODING_AGENT_ROOT'); return; }
  const receiver = await fakeReceiver(t, { questions: true, busyReason: true });
  if (process.platform === 'win32') return windowsTwin(t, root, receiver); // Windows twin: see windows-real-pi.cjs
  const vars = ['ABITO_SOCKET_DIR', 'ABITO_DESKTOP_SOCKET', 'ABITO_QUESTIONS', 'ABITO_QUESTION_TIMEOUT_MS', 'ABITO_NATIVE_CONFIRM'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of vars) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
  Object.assign(process.env, { ABITO_SOCKET_DIR: receiver.runtime, ABITO_DESKTOP_SOCKET: receiver.endpoint,
    ABITO_QUESTIONS: '2', ABITO_QUESTION_TIMEOUT_MS: '300000' });
  delete process.env.ABITO_NATIVE_CONFIRM;

  // The stand-in guard (gentle-pi shape): confirm(title, preview) with no signal/timeout, approve only on === true.
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.test-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = path.join(dir, 'guard.ts');
  fs.writeFileSync(guard, `export default function (pi) {
    pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash') return undefined;
      const approved = (await ctx.ui.confirm(event.input.title, event.input.command)) === true;
      return approved ? undefined : { block: true, reason: 'not approved' };
    });
  }\n`);

  const loader = await import(pathToFileURL(path.join(root, 'dist/core/extensions/loader.js')));
  const { ExtensionRunner } = await import(pathToFileURL(path.join(root, 'dist/core/extensions/runner.js')));
  const cwd = path.resolve(__dirname, '..');
  const runtime = loader.createExtensionRuntime();
  const { extensions, errors } = await loader.loadExtensions([path.resolve(__dirname, '../pi-extension.ts'), guard], cwd,
    { on: () => () => {}, emit: () => {} }, runtime);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 2);
  const runner = new ExtensionRunner(extensions, runtime, cwd, { getSessionId: () => 'real-confirm-session' }, undefined);

  // Pi's terminal: the TUI confirm, which resolves false on its signal abort (interactive-mode.js:2136-2162).
  const terminal = [];
  const terminalUI = {
    confirm: (title, message, opts) => new Promise(resolve => {
      const call = { title, message, opts, resolve }; terminal.push(call);
      if (opts?.signal?.aborted) { resolve(false); return; }
      opts?.signal?.addEventListener('abort', () => resolve(false), { once: true });
    }),
    select: async () => undefined, input: async () => undefined, notify: () => {},
  };
  runner.setUIContext(terminalUI, 'tui');
  const shared = runner.createContext().ui;
  const originalShared = shared.confirm;

  const subscribed = receiver.next('questions_hello');
  await runner.emit({ type: 'session_start', reason: 'startup' });
  await subscribed; await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(runner.createContext().ui.confirm, originalShared, 'the shared confirm is wrapped');
  const wrappedFirst = runner.createContext().ui.confirm;
  // a second session_start (reload) re-subscribes the transport; the wrapper must not stack
  const resubscribed = receiver.next('questions_hello');
  await runner.emit({ type: 'session_start', reason: 'reload' });
  await resubscribed; await new Promise(resolve => setTimeout(resolve, 20));
  const wrappedOnce = runner.createContext().ui.confirm;
  assert.notEqual(wrappedOnce, originalShared);
  assert.notEqual(wrappedFirst, originalShared); // a stacked wrapper would make the shutdown check below fail

  const bash = (title, command) => runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: `c-${Math.random()}`, input: { title, command } });

  // 1) island «Sí» first → the guard sees true → not blocked; the terminal dialog is withdrawn
  let frame = receiver.next('question');
  let call = bash('Allow guarded forced git branch deletion?', 'git branch -D feature/old-spike');
  let q = await frame;
  assert.equal(q.kind, 'approval');
  assert.equal(q.text, 'Allow guarded forced git branch deletion?\ngit branch -D feature/old-spike', 'verbatim');
  assert.deepEqual(q.options.map(o => o.value), ['yes', 'no']);
  assert.equal(q.agent, 'pi', 'the card says it comes from Pi');
  receiver.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'yes' } });
  assert.equal(await call, undefined, 'approved from the island: the guard does not block');
  assert.equal(terminal.at(-1).opts.signal.aborted, true, 'terminal withdrawn');

  // 2) terminal first → its «no» wins; the island question is withdrawn
  frame = receiver.next('question');
  call = bash('Allow guarded git push?', 'git push origin main');
  q = await frame;
  const cancelled = receiver.next('question_cancel');
  terminal.at(-1).resolve(false);
  assert.deepEqual(await call, { block: true, reason: 'not approved' });
  assert.equal((await cancelled).id, q.id, 'island question withdrawn');

  // 3) the island expiring / closing never approves: the terminal keeps waiting and decides
  frame = receiver.next('question');
  call = bash('Allow guarded git rebase?', 'git rebase -i HEAD~3');
  q = await frame;
  receiver.send({ v: 1, type: 'question_closed', questionVersion: 1, project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'system', reason: 'expired' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(terminal.at(-1).opts.signal.aborted, false, 'the terminal is still asking');
  terminal.at(-1).resolve(true);
  assert.equal(await call, undefined, 'the terminal approved it');

  // 4) sensitive → never sent to the island; the terminal confirm runs untouched
  const before = receiver.frames.filter(f => f.type === 'question').length;
  call = bash('Allow guarded git push?', 'git push https://alvaro:ghp_example@github.com/o/r.git main');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(receiver.frames.filter(f => f.type === 'question').length, before, 'nothing crossed to Abito');
  assert.equal(terminal.at(-1).opts?.signal, undefined, 'the original call, no race signal');
  terminal.at(-1).resolve(false);
  assert.deepEqual(await call, { block: true, reason: 'not approved' });

  // installs once; shutdown restores Pi's own confirm
  assert.equal(wrappedOnce, runner.createContext().ui.confirm);
  await runner.emit({ type: 'session_shutdown' });
  assert.equal(runner.createContext().ui.confirm, originalShared, 'unwrapped on shutdown');
});

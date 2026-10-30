'use strict';
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { viaPipe } = require('./fake-receiver.cjs');
const { handleClaudeHook: raw_handleClaudeHook, ALLOW, DENY } = require('../src/claude.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);
const cwd = path.resolve(__dirname, '..');
const TEST_ENV = offlineEnv('nonexistent-r13');
const rule = (destination = 'session', ruleContent = 'ls') => ({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent }], behavior: 'allow', destination });
async function run(suggestions, value = 'deny', over = {}, mutate) {
  let question;
  const result = await handleClaudeHook({ event: 'permission-request', env: TEST_ENV,
    input: JSON.stringify({ cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: suggestions, ...over }),
    clientFactory: () => ({ ask: async q => { question = q; if (mutate) mutate(q); return { status: 'answered', answer: { type: 'option', value } }; } }) });
  return { question, result };
}
const values = q => q.options.map(o => o.value);
const decision = r => JSON.parse(r.stdout).hookSpecificOutput.decision;
test('R13 a: session rule is between allow once and deny; echo original', async () => {
  const entry = rule(); const { question, result } = await run([entry], 'allow_suggestion_1');
  assert.deepEqual(values(question), ['allow', 'allow_suggestion_1', 'deny']);
  assert.match(question.options[1].description, /«ls».*solo esta sesión/);
  assert.deepEqual(decision(result), { behavior: 'allow', updatedPermissions: [entry] });
  assert.equal(question.options[0].label, 'Aprobar una vez');
});
test('R13 b: localSettings names the exact local settings file', async () => {
  const { question, result } = await run([rule('localSettings')], 'allow_suggestion_1');
  assert.match(question.options[1].description, /se guarda en \.claude\/settings\.local\.json/);
  assert.equal(decision(result).updatedPermissions[0].destination, 'localSettings');
});
test('R13 c: reject every unsupported, wider, sensitive, lossy or trimmed update', async () => {
  const bad = ['projectSettings', 'userSettings', 'unknown'].map(d => rule(d));
  bad.push(rule('session', '*'), rule('session', 'ls *'), { ...rule(), rules: [{ toolName: 'Write', ruleContent: 'ls' }] },
    ...['default', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual'].map(mode => ({ type: 'setMode', mode, destination: 'session' })),
    ...['replaceRules', 'removeRules', 'removeDirectories', 'unknown'].map(type => ({ ...rule(), type })),
    { ...rule(), extra: true }, { ...rule(), behavior: 'ask' }, { ...rule(), rules: [{ toolName: 'Bash' }] });
  for (const e of bad) { const { question, result } = await run([e], 'allow_suggestion_1'); assert.deepEqual(values(question), ['allow', 'deny']); assert.equal(result.stdout, ''); }
  for (const over of [
    { tool_name: 'mcp__s__t', tool_input: {} },
    ...['cat /etc/passwd', 'cat .claude/settings.json', 'cat ~/.config/tool', 'cat ~/.ssh/id_rsa', 'x'.repeat(500), 'ls\nwhoami'].map(command => ({ tool_input: { command } })),
    { tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'example.txt'), content: 'x'.repeat(161) } },
    { tool_name: 'Write', tool_input: { file_path: path.join(cwd, '.claude/settings.json'), content: 'x' } },
  ]) {
    const { question, result } = await run([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'allow_suggestion_1', over);
    assert.ok(!values(question).some(v => v.startsWith('allow_suggestion_'))); assert.equal(result.stdout, '');
  }
});
test('R13 d: malformed, huge, duplicate arrays preserve main options; max two extras', async () => {
  for (const s of [null, {}, 'x', [null, [], 3, {}], Array(33).fill(rule()), [rule('session', 'x'.repeat(4097))]]) {
    const { question, result } = await run(s, 'allow'); assert.deepEqual(values(question), ['allow', 'deny']); assert.equal(result.stdout, ALLOW);
  }
  const { question } = await run([rule(), rule(), rule('localSettings'), rule('localSettings')]);
  assert.deepEqual(values(question), ['allow', 'allow_suggestion_1', 'allow_suggestion_2', 'deny']);
  for (const o of question.options) { assert.ok([...o.label].length <= 60); assert.ok([...o.description].length <= 160); }
  const long = 'echo ' + 'x'.repeat(150);
  const dropped = await run([rule('session', long)], 'allow', { tool_input: { command: long } });
  assert.deepEqual(values(dropped.question), ['allow', 'deny']); assert.equal(dropped.result.stdout, ALLOW);
});
test('R13 e: unknown, stale, forged and withdrawn selections cannot allow', async () => {
  for (const v of ['allow_suggestion_0', 'allow_suggestion_2', 'allow_suggestion_99', 'allow_suggestion_1:ls', 'terminal']) assert.equal((await run([rule()], v)).result.stdout, '');
  assert.equal((await run([], 'allow_suggestion_1')).result.stdout, '');
  const r = await handleClaudeHook({ event: 'permission-request', env: TEST_ENV, input: JSON.stringify({ cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [rule()] }), clientFactory: () => ({ ask: async () => ({ status: 'cancelled', answer: { type: 'option', value: 'allow_suggestion_1' } }) }) });
  assert.equal(r.stdout, '');
});
test('R13 f: card mutation cannot change echoed entry; crafted control strings never grant', async () => {
  const entry = rule();
  const { result } = await run([entry], 'allow_suggestion_1', {}, q => { q.options[1].label = 'evil\n\u202e\x1b[31m'; q.options[1].description = 'forged *'; });
  assert.deepEqual(decision(result).updatedPermissions, [entry]);
  for (const s of ['ls\nwhoami', 'ls\u202e', 'ls\x1b[31m']) {
    const { question, result: r } = await run([rule('session', s)], 'allow_suggestion_1', { tool_input: { command: s } });
    assert.ok(!values(question).includes('allow_suggestion_1')); assert.equal(r.stdout, '');
  }
});
test('R13 g: ordinary allow/deny remain byte-identical even with suggestions', async () => {
  for (const [v, out] of [['allow', ALLOW], ['deny', DENY], ['terminal', '']]) assert.equal((await run([rule()], v)).result.stdout, out);
});
test('R13 permitted setMode, exact file and directory entries echo unchanged', async () => {
  // A canonical directory: macOS `/tmp` is a symlink to `/private/tmp` and the product refuses non-canonical paths (fail closed).
  // Short on purpose: the product drops a suggestion whose description exceeds 160 characters, and macOS's per-user tmpdir
  // (/private/var/folders/xx/.../T) pushes the third entry over that limit (run 40751626543). realpath('/tmp') is /private/tmp there.
  const win = process.platform === 'win32';
  const dir = win ? require('./platform-env.cjs').tmpBase() : require('node:fs').realpathSync('/tmp');
  const file = win ? `${dir}\\r13-example.txt` : `${dir}/r13-example.txt`;
  for (const entry of [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: file }], behavior: 'allow', destination: 'session' },
    // Claude's `//absolute` rule form and the `cd /dir` directory entry are POSIX path syntaxes: not offered for Windows paths (fail closed).
    ...(win ? [] : [{ type: 'addRules', rules: [{ toolName: 'Write', ruleContent: '/' + file }], behavior: 'allow', destination: 'localSettings' }])]) {
    const { question, result } = await run([entry], 'allow_suggestion_1', { cwd: dir, tool_name: 'Write', tool_input: { file_path: file, content: 'hello' } });
    assert.equal(question.options.length, 3); assert.deepEqual(decision(result).updatedPermissions, [entry]);
  }
  if (win) { // Windows twin: a `cd C:\\dir` command offers NO directory suggestion (only the main allow/deny pair)
    const r = await run([{ type: 'addDirectories', directories: [dir], destination: 'session' }], 'allow', { tool_input: { command: `cd ${dir}` } });
    assert.deepEqual(r.question.options.map(o => o.value), ['allow', 'deny']);
    return;
  }
  const entry = { type: 'addDirectories', directories: [dir], destination: 'session' };
  const r = await run([entry], 'allow_suggestion_1', { tool_input: { command: `cd ${dir}` } });
  assert.deepEqual(decision(r.result).updatedPermissions, [entry]);
});
test('R13 wire exposes only derived options, fixed tokens; real QP/1 selection echoes original', async t => {
  const { fakeReceiver } = require('./fake-receiver.cjs');
  const receiver = await fakeReceiver(t, { questions: true });
  const entry = rule('localSettings');
  const pending = receiver.next('question').then(q => {
    assert.deepEqual(values(q), ['allow', 'allow_suggestion_1', 'deny']);
    assert.doesNotMatch(JSON.stringify(q), /permission_suggestions|updatedPermissions|toolName|ruleContent/);
    receiver.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId,
      at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'allow_suggestion_1' } });
  });
  const result = await handleClaudeHook({ event: 'permission-request', env: { ABITO_DESKTOP_SOCKET: receiver.endpoint, ABITO_SOCKET_DIR: receiver.runtime },
    input: JSON.stringify({ cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [entry] }) });
  await pending;
  assert.deepEqual(decision(result).updatedPermissions, [entry]);
});
test('R13 frozen snapshot stays original after source mutation', () => {
  const { planSuggestions } = require('../src/claude-suggestions.cjs');
  const source = rule();
  const p = planSuggestions({ cwd, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [source] }, { text: 'Bash: ls', lossy: false });
  source.rules[0].ruleContent = '*';
  assert.equal(p[0].original.rules[0].ruleContent, 'ls');
  for (const v of [p, p[0], p[0].original, p[0].original.rules, p[0].original.rules[0]]) assert.ok(Object.isFrozen(v));
  assert.throws(() => { p[0].original.rules[0].ruleContent = '*'; }, TypeError);
});
test('R13 h + differential: HEAD source in memory, Bash/Write/Codex stdout and exit unchanged', async t => {
  const { execFileSync } = require('node:child_process');
  const Module = require('node:module');
  const root = path.resolve(__dirname, '../../..');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const cache = new Map();
  function base(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const filename = path.join(root, name);
    const mod = new Module(filename, module); cache.set(name, mod);
    mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const nativeRequire = Module.createRequire(filename);
    mod.require = id => id.startsWith('.') ? base(path.posix.normalize(path.posix.join(path.posix.dirname(name), id))) : nativeRequire(id);
    mod._compile(execFileSync('git', ['show', `${revision}:${name}`], { cwd: root, encoding: 'utf8' }), filename);
    return mod.exports;
  }
  const oldClaude = base('apps/desktop-harness/src/claude.cjs').handleClaudeHook;
  const { handleCodexHook } = require('../src/codex.cjs');
  let count = 0;
  // S4/T2: Codex is not in this differential any more — it can no longer answer, so its output is asserted below instead.
  for (const [current, old, over] of [[handleClaudeHook, oldClaude, {}],
    [handleClaudeHook, oldClaude, { cwd: '/tmp', tool_name: 'Write', tool_input: { file_path: '/tmp/r13-example.txt', content: 'hello' } }]]) {
    for (const value of ['allow', 'deny', 'terminal', 'allow_suggestion_1', 'forged']) {
      for (const status of ['answered', 'cancelled']) {
        const input = JSON.stringify({ cwd, session_id: 'r13-diff', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, ...over });
        const opts = { event: 'permission-request', env: TEST_ENV, input,
          clientFactory: () => ({ ask: async () => ({ status, answer: { type: 'option', value } }) }) };
        const a = await current(opts), b = await old(opts);
        // Koda 0.1 T2: the product name in what the hook prints is the ONLY intended difference from the old source; every other byte (and the exit code) must match
        const renamed = text => (typeof text === 'string' ? text.replace(/\bAbito island\b/g, 'Koda island') : text);
        assert.deepEqual({ stdout: a.stdout, exitCode: a.exitCode }, { stdout: renamed(b.stdout), exitCode: b.exitCode }); count++;
      }
    }
  }
  // S4/T2: whatever the island would have answered, Codex prints nothing and mints no suggestion rule.
  for (const value of ['allow', 'deny', 'allow_suggestion_1', 'forged']) {
    const input = JSON.stringify({ cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [rule()] });
    let contacted = 0;
    const opts = { event: 'permission-request', env: TEST_ENV, input, clientFactory: () => ({
      ask: async () => { contacted++; return { status: 'answered', answer: { type: 'option', value } }; },
      attention: async () => { contacted++; return { status: 'sent' }; },
      notify: async () => ({ status: 'sent' }), clearAttention: async () => ({ status: 'sent' }) }) };
    const r = await handleCodexHook(opts);
    assert.deepEqual({ stdout: r.stdout, exitCode: r.exitCode }, { stdout: '', exitCode: 0 }, value);
    assert.equal(contacted, 1, 'one notice, never a question');
  }
  t.diagnostic(`HEAD ${revision}: ${count} no-suggestion stdout/exit comparisons identical; Codex never answers (4 answers).`);
});

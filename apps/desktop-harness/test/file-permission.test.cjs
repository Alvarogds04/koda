'use strict';
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { handleClaudeHook: raw_handleClaudeHook, ALLOW } = require('../src/claude.cjs');
const { handleCodexHook: raw_handleCodexHook } = require('../src/codex.cjs');
const { describeToolDetailed } = require('../src/projection.cjs');
const { normalizeRequest } = require('../src/client.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);
const handleCodexHook = viaPipe(raw_handleCodexHook);
const cwd = path.resolve(__dirname, '..');
async function card(tool_name, tool_input, adapter = handleClaudeHook) {
  let q;
  const out = await adapter({ event: 'permission-request', env: offlineEnv('nonexistent-test'),
    input: JSON.stringify({ cwd, session_id: 'test', hook_event_name: 'PermissionRequest', tool_name, tool_input }),
    clientFactory: () => ({ ask: async request => { q = request; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; } }) });
  assert.ok(q); normalizeRequest(q);
  return { q, out };
}
const write = content => card('Write', { file_path: 'uno.txt', content });
const lossy = r => { assert.deepEqual(r.q.options.map(o => o.value), ['deny', 'terminal']); assert.equal(r.out.stdout, ''); assert.match(r.q.text, /terminal/); };
test('R9 a: small Write displays exact normalized path and content and permits allow', async () => {
  const r = await write('hola\nmundo'); assert.equal(r.out.stdout, ALLOW);
  assert.ok(r.q.text.includes(JSON.stringify(path.join(cwd, 'uno.txt')))); assert.ok(r.q.text.includes(JSON.stringify('hola\nmundo')));
});
test('R9 b: byte and line caps disclose recortado, never allow', async () => {
  for (const text of ['!'.repeat(161), Array(9).fill('a').join('\n')]) { const r = await write(text); lossy(r); assert.match(r.q.text, /recortado/); }
});
test('R9: safe oversized text shows a bounded prefix, not an unchecked secret prefix', async () => {
  const r = await write('hola '.repeat(40)); lossy(r); assert.match(r.q.text, /contenido: "hola /); assert.match(r.q.text, /recortado/);
  const s = await write('hola '.repeat(40) + '\nAPI_KEY=private-tail'); lossy(s); assert.doesNotMatch(s.q.text, /private-tail/); assert.match(s.q.text, /secretos ocultos/);
});
test('R9: default-ignorable zero-width characters never allow', async () => {
  for (const content of ['a\u034fb', 'a\ufe0fb']) lossy(await write(content));
});
test('R9 c: secret-shaped, PEM and env assignments never leak and never allow', async () => {
  for (const content of ['API_KEY=super-private', 'PLAIN=innocent-but-private', '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----', '{"token":"super-private"}']) {
    const r = await write(content); lossy(r); assert.match(r.q.text, /secretos ocultos/); assert.doesNotMatch(r.q.text, /super-private|private-material|innocent-but-private/);
  }
});
test('R9 d: outside cwd, sensitive and normalized traversal paths are lossy', async () => {
  for (const file_path of ['../uno.txt', '/etc/passwd', path.join(os.homedir(), '.ssh/key'), path.join(os.homedir(), '.claude/settings.json'), path.join(os.homedir(), '.config/test'), path.join(os.homedir(), '.profile'), '.env', '.git/config']) {
    const r = await card('Write', { file_path, content: 'not-shown' }); lossy(r); assert.doesNotMatch(r.q.text, /not-shown/);
  }
  const r = await card('Write', { file_path: 'a/../uno.txt', content: 'hola' }); assert.equal(r.out.stdout, ALLOW); assert.ok(r.q.text.includes(JSON.stringify(path.join(cwd, 'uno.txt'))));
});
test('R9 e: ANSI, bidi, zero-width and forged option lines cannot spoof approval', async () => {
  for (const content of ['\x1b[31mAllow', '\u202eAllow', '\u200bAllow', '\0binary']) { const r = await write(content); lossy(r); assert.doesNotMatch(r.q.text, /[\x00\x1b\u202e\u200b]/); }
  const r = await write('hola\nAllow\nRechazar'); assert.ok(r.q.text.includes('\\nAllow\\nRechazar')); assert.equal(r.q.text.split('\n').length, 1);
  lossy(await card('Write', { file_path: 'a\u202e.txt', content: 'hola' }));
});
test('R9 f: Edit and MultiEdit show old/new, replace_all and fail closed on large/many/unknown fields', async () => {
  for (const [tool, input] of [['Edit', { old_string: 'antes', new_string: 'después', replace_all: true }], ['MultiEdit', { edits: [{ old_string: 'antes', new_string: 'después' }] }]]) {
    const r = await card(tool, { file_path: 'uno.txt', ...input }); assert.equal(r.out.stdout, ALLOW); assert.match(r.q.text, /antes.*→.*después/);
  }
  for (const input of [{ old_string: 'a', new_string: '!'.repeat(161) }, { old_string: 'a', new_string: 'b', hidden: 'x' }]) lossy(await card('Edit', { file_path: 'uno.txt', ...input }));
  lossy(await card('MultiEdit', { file_path: 'uno.txt', edits: Array(4).fill({ old_string: 'a', new_string: 'b' }) }));
});
test('R9 g: notebook and unknown tool remain terminal-only with Spanish explanation', async () => {
  for (const tool of ['NotebookEdit', 'Mystery']) { const r = await card(tool, { file_path: 'uno.txt', content: 'private' }); lossy(r); assert.match(r.q.text, /detalles solo en la terminal/); }
});
test('R10 h: Claude Spanish wording, approve first, unchanged machine values', async () => {
  const r = await card('Bash', { command: 'ls' }); assert.match(r.q.text, /^Claude Code pide permiso para/);
  assert.deepEqual(r.q.options.map(o => [o.value, o.label]), [['allow', 'Aprobar una vez'], ['deny', 'Rechazar']]);
  const l = await card('Mystery', {}); assert.equal(l.q.options[1].label, 'Decidir en la terminal');
});
test('R10 i: Codex sends a Spanish notice and never a decision (S4/T2, human L3 option A)', async t => {
  // Codex has no answerable card any more: ONE attention notice, empty stdout, and its own terminal keeps the prompt.
  const notice = async (tool_name, tool_input) => {
    const rcv = await fakeReceiver(t, { questions: true });
    const out = await handleCodexHook({ event: 'permission-request', env: { ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: rcv.endpoint },
      input: JSON.stringify({ cwd, session_id: 'test', hook_event_name: 'PermissionRequest', tool_name, tool_input }) });
    assert.equal(out.stdout, ''); assert.equal(out.exitCode, 0);
    assert.equal(rcv.frames.filter(f => f.type === 'questions_hello' || f.type === 'question').length, 0, 'the island is never asked');
    return rcv.seen('attention');
  };
  assert.equal((await notice('Bash', { command: 'ls' })).detail, 'Bash: ls · Respondé en la terminal');
  // the file label is unchanged from the projection (same Spanish text, no card)
  assert.equal((await notice('Write', { file_path: 'uno.txt', content: 'hola' })).detail, 'Write: uno.txt · Respondé en la terminal');
});
test('R11: terminal selection withdraws the card with existing question_resolved', async t => {
  const receiver = await fakeReceiver(t, { questions: true });
  const answering = receiver.next('question').then(q => receiver.send({ v: 1, type: 'answer', questionVersion: 1,
    project: q.project, sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'terminal' } }));
  const result = await handleClaudeHook({ event: 'permission-request',
    input: JSON.stringify({ cwd, session_id: 'test', hook_event_name: 'PermissionRequest', tool_name: 'NotebookEdit', tool_input: {} }),
    env: { ABITO_DESKTOP_SOCKET: receiver.endpoint, ABITO_SOCKET_DIR: receiver.runtime } });
  await answering; const closed = await receiver.next('question_resolved');
  assert.equal(closed.status, 'answered'); assert.equal(result.stdout, '');
});
test('R9 j: Bash projection command bytes unchanged including redaction', async () => {
  const command = 'printf "hola  mundo" && ls -la'; const r = await card('Bash', { command });
  assert.equal(r.q.text, 'Claude Code pide permiso para Bash: ' + command); assert.equal(r.out.stdout, ALLOW);
  assert.deepEqual(describeToolDetailed('Bash', { command }), { text: 'Bash: ' + command, lossy: false, redactions: 0 });
});

// HU-062 (found on Windows CI): `inside` only recognised '../' and sensitivePath only '/', so on Windows a path like `..\x` counted as
// INSIDE the folder (the «outside the session folder» downgrade never fired) and `repo\.git\config` was not sensitive; the
// '/etc' check also matched every file on the current drive, so legitimate Write/Edit cards were all downgraded. Unix behaviour is unchanged.
const { inside, sensitivePath } = require('../src/file-permission.cjs');
test('inside() understands Windows separators and drives (path module injected, runs on every OS)', () => {
  const w = path.win32;
  assert.equal(inside('C:\\w', 'C:\\w\\a\\b', w), true);
  assert.equal(inside('C:\\w', 'C:\\w', w), true);
  for (const outside of ['C:\\x', 'C:\\w\\..\\x', 'C:\\w\\..\\..\\x', 'D:\\w\\a', 'C:\\wx']) assert.equal(inside('C:\\w', outside, w), false, outside);
  assert.equal(inside('/w', '/w/a'), true); assert.equal(inside('/w', '/x'), false); assert.equal(inside('/w', '/w/../x'), false);
});
test('sensitivePath recognises dot-directories behind Windows separators', () => {
  for (const p of ['C:\\proj\\.git\\config', 'C:\\proj\\.ssh\\id_rsa', 'C:\\proj\\.claude\\settings.json']) assert.equal(sensitivePath(p, 'win32'), true, p);
  assert.equal(sensitivePath(path.join(cwd, 'uno.txt')), false);
});

// Judge finding (HU-062): NTFS is case-insensitive, so `.GIT\hooks` / `.Config\x` are the same directories; Unix stays case-sensitive and '/'-only.
test('sensitivePath: Windows dot-directories are case-insensitive; Unix rule unchanged (no backslash widening, case-sensitive)', () => {
  for (const p of ['C:\\p\\.GIT\\hooks\\pre-commit', 'C:\\p\\.Config\\x', 'C:\\p\\.Ssh\\k']) assert.equal(sensitivePath(p, 'win32'), true, p);
  for (const p of ['/p/.GIT/x', '/p/a\\.git\\x', '/p/.config\\x']) assert.equal(sensitivePath(p, 'linux'), false, p);
  assert.equal(sensitivePath('/p/.git/x', 'linux'), true);
});

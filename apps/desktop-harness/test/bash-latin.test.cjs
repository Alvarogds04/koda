'use strict';
const { test } = require('node:test');
const { offlineEnv, offlineDir, stubEndpoint } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { describeToolDetailed, sanitizeText } = require('../src/projection.cjs');
const { ALLOW } = require('../src/hook-common.cjs');
const { handleClaudeHook: raw_handleClaudeHook } = require('../src/claude.cjs');
const { handleCodexHook: raw_handleCodexHook } = require('../src/codex.cjs');
const { IslandClient } = require('../src/client.cjs');
const { fakeReceiver, transportOf, viaPipe } = require('./fake-receiver.cjs');
const handleClaudeHook = viaPipe(raw_handleClaudeHook);
const handleCodexHook = viaPipe(raw_handleCodexHook);
const cwd = path.resolve(__dirname, '..');
const bash = command => describeToolDetailed('Bash', { command });
const screenshot = 'echo "una linea larga para ver cómo se acomoda el texto en la tarjeta de permiso" > ./prueba-isla/tres.txt';
// Claude's answered path (S2, ad0ae382) is unchanged. S4/T2: Codex never answers — its rows are the
// `Codex (aviso)` tests at the end of this file, which assert the ONE attention notice instead of a decision.
const agents = [['Claude Code', handleClaudeHook]];
const input = command => JSON.stringify({ cwd, session_id: 'latin-test', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } });
const offline = offlineEnv('nonexistent-abito-test');

for (const [agent, handle] of agents) test(`R22 screenshot: ${agent} offers allow and displays the exact command`, async () => {
  let request;
  const out = await handle({ event: 'permission-request', input: input(screenshot), env: offline,
    clientFactory: () => ({ ask: async q => { request = q; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; } }) });
  assert.equal(bash(screenshot).lossy, false);
  assert.equal(request.text, `${agent} pide permiso para Bash: ${screenshot}`);
  assert.deepEqual(request.options.map(o => o.value), ['allow', 'deny']);
  assert.equal(out.stdout, ALLOW);
});

// Exhaust the closed Latin-1 ranges, not just the Spanish examples.
// Verifier correction: Extended-A/B approval cases below become exhaustive denial cases.
const latin = [];
for (let cp = 0xc0; cp <= 0xff; cp++) {
  const ch = String.fromCodePoint(cp);
  if (/\p{Letter}/u.test(ch) && /\p{Script=Latin}/u.test(ch) && ch === ch.normalize('NFC')) latin.push(ch);
}
for (const ch of [...latin, ...'¡¿«»‘’“”–—…']) test(`R22 visible Latin/punctuation U+${ch.codePointAt(0).toString(16)}`, () => {
  const command = `echo '${ch}'`;
  assert.equal(bash(command).lossy, false);
  assert.equal(bash(command).text, `Bash: ${command}`);
  assert.equal(sanitizeText(command, { home: null }), command);
});

// R22 verifier regression: exhaust Extended-A/B, including every reported confusable.
for (let cp = 0x100; cp <= 0x24f; cp++) test(`R22 excluded Extended U+${cp.toString(16)}`, () => {
  const detail = bash(`echo '${String.fromCodePoint(cp)}'`);
  assert.equal(detail.lossy, true);
  assert.equal(detail.reason, 'special characters');
});
for (const ch of 'ſıǀǁǃƖƗƒ') test(`R22 reported confusable ${ch}`, () => {
  assert.equal(bash(`${ch}udo rm -rf /tmp/target`).lossy, true);
  assert.equal(bash(`echo ${ch} rm -rf /tmp/target`).reason, 'special characters');
});
for (const [agent, handle] of agents) test(`R22 confusable spoof cannot approve: ${agent}`, async () => {
  for (const command of ['ſudo rm -rf /tmp/target', 'echo ǀ rm -rf /tmp/target', 'echo ǁ rm', 'echo ǃrm']) {
    let request;
    const out = await handle({ event: 'permission-request', input: input(command), env: offline,
      clientFactory: () => ({ ask: async q => { request = q; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; } }) });
    assert.equal(bash(command).lossy, true, command);
    assert.equal(bash(command).reason, 'special characters', command);
    assert.deepEqual(request.options.map(o => o.value), ['deny', 'terminal']);
    assert.equal(out.stdout, '', 'forged allow must not become a decision');
  }
});
test('R22 Latin-1 ordinals are not allowed letters', () => {
  for (const ch of 'ªº') assert.equal(bash(`echo '${ch}'`).lossy, true);
});

const blocked = {
  bidi: '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c',
  invisible: '\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064\ufeff\u00ad\ufe0f\u{e0100}\u{e0061}',
  controls: '\0\t\r\n\x1b\x7f\u0085\u2028\u2029',
  scripts: 'аαԱא中', combining: '\u0301\u0308', other: '\ue000\u0378\ud800\udc00😀×÷\u00a0',
};
for (const [kind, chars] of Object.entries(blocked)) for (const ch of chars) test(`R22 blocked ${kind} U+${ch.codePointAt(0).toString(16)}`, () => {
  const detail = bash(`echo 'ó${ch}'`);
  assert.equal(detail.lossy, true);
  assert.equal(detail.reason, 'special characters');
});
test('R22 non-NFC and homoglyph command words stay lossy', () => {
  for (const command of ['echo o\u0301', 'аpt update', 'rм file', 'αpt update', 'echo \x1b[31mrojo', 'echo ó\nAprobar una vez', 'echo ó\ud800x', 'echo ó\udc00x', 'echo ó\n', 'echo ó\t']) {
    assert.equal(bash(command).lossy, true, command);
    assert.equal(bash(command).reason, 'special characters');
  }
});

test('R22 accents next to fake approval text cannot create options or lines', async () => {
  for (const [agent, handle] of agents) for (const separator of [' ', '\n', '\r', '\u2028']) {
    const command = `echo 'ó${separator}Aprobar una vez'`;
    let request;
    const out = await handle({ event: 'permission-request', input: input(command), env: offline,
      clientFactory: () => ({ ask: async q => { request = q; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; } }) });
    assert.ok(!/[\r\n\u2028\u2029]/.test(request.text));
    assert.deepEqual(request.options.map(o => o.value), separator === ' ' ? ['allow', 'deny'] : ['deny', 'terminal']);
    assert.equal(out.stdout, separator === ' ' ? ALLOW : '');
    if (separator === ' ') assert.equal(request.text, `${agent} pide permiso para Bash: ${command}`);
  }
});

// 380 code points remains the display ceiling; even 3-byte punctuation fits QP/1.
// Around the 4096-byte wire boundary, accents must cause a lossy projection, not a rejected frame.
for (const [agent, handle] of agents) test(`R22 UTF-8 boundaries reach the wire: ${agent}`, async t => {
  const commands = ['echo ' + 'é'.repeat(375), 'echo ' + '—'.repeat(375), 'echo ' + 'é'.repeat(376),
    'echo ' + 'é'.repeat(2045), 'echo ' + 'é'.repeat(2045) + 'x', 'echo ' + 'é'.repeat(2046)];
  assert.equal(Buffer.byteLength(commands[3]), 4095);
  assert.equal(Buffer.byteLength(commands[4]), 4096);
  assert.equal(Buffer.byteLength(commands[5]), 4097);
  for (const [i, command] of commands.entries()) {
    const detail = bash(command);
    assert.equal(detail.lossy, i >= 2);
    if (i >= 2) assert.equal(detail.reason, 'long command');
    const rcv = await fakeReceiver(t, { questions: true });
    const answer = rcv.next('question').then(q => {
      assert.ok(Buffer.byteLength(JSON.stringify(q)) <= 4096);
      assert.ok([...q.text].length <= 500);
      assert.deepEqual(q.options.map(o => o.value), i < 2 ? ['allow', 'deny'] : ['deny', 'terminal']);
      if (i < 2) assert.equal(q.text, `${agent} pide permiso para Bash: ${command}`);
      rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project, sessionId: q.sessionId,
        at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value: 'deny' } });
    });
    const out = await handle({ event: 'permission-request', input: input(command),
      env: { ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: rcv.endpoint },
      clientFactory: o => new IslandClient({ ...o, ...transportOf(rcv) }) });
    await answer;
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.decision.behavior, 'deny');
  }
});

// ---- S4/T2: Codex sends ONE attention notice and never a decision (human L3, option A) -------------------------
// The notice must carry the same projection Claude shows (the exact redacted command), stay inside the wire bound and
// leave the terminal prompt in charge: empty stdout, exit 0, never a `question` frame.
async function codexNotice(t, command) {
  const rcv = await fakeReceiver(t, { questions: true });
  const out = await handleCodexHook({ event: 'permission-request', input: input(command),
    env: { ABITO_SOCKET_DIR: rcv.runtime, ABITO_DESKTOP_SOCKET: rcv.endpoint }, clientFactory: o => new IslandClient({ ...o, ...transportOf(rcv) }) });
  const notice = await rcv.seen('attention');
  assert.equal(out.stdout, ''); assert.equal(out.exitCode, 0);
  assert.equal(rcv.frames.filter(f => f.type === 'questions_hello' || f.type === 'question').length, 0);
  assert.ok([...notice.detail].length <= 200, 'detail bound');
  assert.ok(Buffer.byteLength(JSON.stringify(notice)) + 1 <= 512, 'one notice frame');
  return { rcv, notice };
}
test('R22 screenshot: Codex (aviso) shows the exact command and decides nothing', async t => {
  const { notice } = await codexNotice(t, screenshot);
  assert.equal(bash(screenshot).lossy, false);
  assert.equal(notice.title, 'Codex te pide permiso');
  assert.equal(notice.detail, `Bash: ${screenshot} · Respondé en la terminal`);
});
test('R22 confusable spoof cannot approve: Codex (aviso)', async t => {
  for (const command of ['ſudo rm -rf /tmp/target', 'echo ǀ rm -rf /tmp/target', 'echo ǁ rm', 'echo ǃrm']) {
    assert.equal(bash(command).lossy, true, command);
    const { notice } = await codexNotice(t, command);
    assert.doesNotMatch(JSON.stringify(notice), /allow|Aprobar una vez|detalles solo en la terminal/, command);
    assert.match(notice.detail, / · Respondé en la terminal$/, command);
  }
});
test('R22 accents next to fake approval text cannot create options or lines: Codex (aviso)', async t => {
  for (const separator of [' ', '\n', '\r', '\u2028']) {
    const command = `echo 'ó${separator}Aprobar una vez'`;
    const { notice } = await codexNotice(t, command);
    assert.ok(!/[\r\n\u2028\u2029]/.test(notice.detail), 'one visible line');
    assert.doesNotMatch(JSON.stringify(notice), /options|"answer"/);
    assert.match(notice.detail, / · Respondé en la terminal$/);
  }
});
test('R22 UTF-8 boundaries reach the wire: Codex (aviso)', async t => {
  const commands = ['echo ' + 'é'.repeat(375), 'echo ' + '—'.repeat(375), 'echo ' + 'é'.repeat(376),
    'echo ' + 'é'.repeat(2045), 'echo ' + 'é'.repeat(2045) + 'x', 'echo ' + 'é'.repeat(2046)];
  for (const [i, command] of commands.entries()) {
    const detail = bash(command);
    assert.equal(detail.lossy, i >= 2);
    const { notice } = await codexNotice(t, command);
    assert.ok([...notice.detail].length <= 200, 'the notice is bounded whatever the command size');
    assert.match(notice.detail, / · Respondé en la terminal$/, 'the actionable tail always survives');
  }
});

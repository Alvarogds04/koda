'use strict';
const { test } = require('node:test');
const { unixOnly } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { reduce, lineDiff, appendEvent, spoolPath } = require('../src/recap-hook.cjs');

const BIN = path.resolve(__dirname, '../bin/abito-recap-hook.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'abito-rh-'));

test('line counts match the LCS diff (Coucou DiffEngine port)', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), [2, 1]);
  assert.deepEqual(lineDiff('', 'x\ny\n'), [2, 0]);
  assert.deepEqual(lineDiff('x', 'x'), [0, 0]);
  assert.deepEqual(lineDiff('a\r\nb', 'a\nb'), [0, 0]);
});

test('a prompt becomes a bare marker: no prompt text, no cwd, only the folder name', () => {
  const r = reduce({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/home/me/work/proj', prompt: 'SECRET prompt' }, 1000);
  assert.deepEqual(r, { v: 1, at: 1000, event: 'prompt', session: 's1', project: 'proj' });
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
});

test('tools reduce to a kind and counts; commands, paths and contents never survive', () => {
  const base = { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/w/proj' };
  const cmd = reduce({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' } }, 1);
  assert.deepEqual(cmd, { v: 1, at: 1, event: 'tool', session: 's1', project: 'proj', kind: 'command' });
  const q = reduce({ ...base, tool_name: 'AskUserQuestion', tool_input: { questions: ['private?'] } }, 1);
  assert.equal(q.kind, 'question');
  const edit = reduce({ ...base, tool_name: 'Edit', tool_input: { file_path: '/w/proj/a.rs', old_string: 'a\nb', new_string: 'a\nc\nd' } }, 1);
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.added, 2);
  assert.equal(edit.removed, 1);
  assert.match(edit.file, /^[0-9a-f]{16}$/);
  const write = reduce({ ...base, tool_name: 'Write', tool_input: { file_path: '/w/proj/b.rs', content: 'one\ntwo\n' } }, 1);
  assert.deepEqual([write.added, write.removed], [2, 0]);
  for (const r of [cmd, q, edit, write]) {
    const t = JSON.stringify(r);
    assert.equal(t.includes('secret'), false);
    assert.equal(t.includes('a.rs'), false);
    assert.equal(t.includes('private'), false);
  }
  assert.equal(reduce({ ...base, tool_name: 'Read', tool_input: { file_path: '/x' } }, 1).kind, 'other');
});

test('Stop closes the turn; unknown events and garbage reduce to null', () => {
  assert.equal(reduce({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/b' }, 5).event, 'stop');
  for (const bad of [null, 1, [], {}, { hook_event_name: 'Other' }, { hook_event_name: 'PostToolUse' }]) assert.equal(reduce(bad, 1), null);
});

test('session ids and folder names are cleaned and bounded', () => {
  const r = reduce({ hook_event_name: 'UserPromptSubmit', session_id: 'a b/../' + 'x'.repeat(300), cwd: '/w/' + 'p'.repeat(200) + '\u0007' }, 1);
  assert.match(r.session, /^[A-Za-z0-9._-]{1,128}$/);
  assert.ok(r.project.length <= 64);
  assert.equal(/[\u0000-\u001f]/.test(r.project), false);
});

test('events are appended 0600, one line each; a symlink or an oversize spool is refused', unixOnly('registered gap HU-062 (spool privacy is the island runtime DACL on Windows)'), () => {
  const rt = tmp();
  assert.equal(appendEvent(rt, { v: 1, a: 1 }), true);
  assert.equal(appendEvent(rt, { v: 1, a: 2 }), true);
  assert.equal(fs.statSync(spoolPath(rt)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(spoolPath(rt), 'utf8').trim().split('\n').map(JSON.parse), [{ v: 1, a: 1 }, { v: 1, a: 2 }]);
  const rt2 = tmp();
  const victim = path.join(tmp(), 'v');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, spoolPath(rt2));
  assert.equal(appendEvent(rt2, { v: 1 }), false);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  const rt3 = tmp();
  fs.writeFileSync(spoolPath(rt3), 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
  assert.equal(appendEvent(rt3, { v: 1 }), false);
  assert.equal(appendEvent('/nonexistent-abito/x', { v: 1 }), false);
});

test('the script is silent, exits 0 and writes the reduced event', () => {
  const rt = tmp();
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/w/proj', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const r = spawnSync(process.execPath, [BIN], { input, env: { PATH: process.env.PATH, ABITO_SOCKET_DIR: rt }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(JSON.parse(fs.readFileSync(spoolPath(rt), 'utf8')).kind, 'command');
  const bad = spawnSync(process.execPath, [BIN], { input: 'nope', env: { PATH: process.env.PATH, ABITO_SOCKET_DIR: '/nonexistent-abito/x' }, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout + bad.stderr, '');
});

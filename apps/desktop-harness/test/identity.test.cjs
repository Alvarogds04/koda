'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { projectId, sessionToken, displayName, agentSlug, displayFields } = require('../src/identity.cjs');

const RULE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
test('projectId is sha256 of realpath', () => {
  const real = fs.realpathSync(__dirname);
  assert.equal(projectId(__dirname), createHash('sha256').update(real).digest('hex'));
  assert.equal(projectId(__dirname + '/../test'), projectId(__dirname));
  assert.throws(() => projectId('/definitely/not/here-xyz'));
});
test('sessionToken keeps valid, normalizes invalid, hash-falls-back', () => {
  assert.equal(sessionToken('abc-123_x.y'), 'abc-123_x.y');
  assert.equal(sessionToken('a b/c'), 'a-b-c');
  assert.equal(sessionToken('--abc--'), 'abc');
  const hashed = raw => 'h-' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
  for (const raw of ['', '///', '.-_', 'x'.repeat(129)]) {
    const t = sessionToken(raw);
    assert.match(t, RULE); assert.ok(t.length <= 128);
    assert.equal(t, hashed(raw));
  }
  for (const raw of [undefined, null, 42, {}]) assert.equal(sessionToken(raw), hashed(''));
  assert.equal(sessionToken('x'.repeat(128)), 'x'.repeat(128));
  assert.notEqual(sessionToken('x'.repeat(129)), sessionToken('x'.repeat(130)));
});

test('display fields (S10 L25): basename on the wire alphabet, a closed agent slug, both or neither', () => {
  const os = require('node:os'), path = require('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-id-'));
  const make = name => { const d = path.join(base, name); fs.mkdirSync(d); return d; };
  assert.equal(displayName(make('my-project')), 'my-project');
  assert.equal(displayName(make('ñandú app')), '_and_ app');
  assert.equal(displayName(make('a'.repeat(70))), 'a'.repeat(64));
  assert.equal(displayName('/definitely/not/here-xyz'), null);
  assert.equal(displayName('/'), null, 'the root has no basename');
  for (const ok of ['pi', 'claude-code', 'a.b_c-1']) assert.equal(agentSlug(ok), ok);
  for (const bad of ['', 'Pi', '-x', 'a b', 'a/b', 'x'.repeat(33), 5, null, undefined]) assert.equal(agentSlug(bad), null, String(bad));
  assert.deepEqual(displayFields(make('proj'), 'codex'), { projectName: 'proj', agent: 'codex' });
  assert.deepEqual(displayFields(make('proj2'), 'Codex'), {}, 'a bad agent drops BOTH');
  assert.deepEqual(displayFields('/definitely/not/here-xyz', 'codex'), {}, 'no name drops BOTH');
});

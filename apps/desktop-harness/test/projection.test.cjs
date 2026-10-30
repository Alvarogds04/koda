'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/projection.cjs');

const HOME = '/home/dev';
test('home collapse, control strip, whitespace, truncation by code points', () => {
  assert.equal(p.sanitizeText('/home/dev/x/y', { max: 100, home: HOME }), '~/x/y');
  assert.equal(p.sanitizeText('/home/devx/y', { max: 100, home: HOME }), '/home/devx/y');
  assert.equal(p.sanitizeText('a\u0000b\u001b[31m\n\t c\u007f', { max: 100 }), 'ab[31m c');
  assert.equal(p.sanitizeText('😀'.repeat(10), { max: 5 }), '😀😀😀😀…');
  assert.equal([...p.sanitizeText('x'.repeat(100000), { max: 500 })].length, 500);
  for (const bad of [undefined, null, 5, {}, [], Symbol('s')]) assert.equal(p.sanitizeText(bad, { max: 10 }), '');
});
test('options: limits, tokens unique and valid', () => {
  const opts = p.buildOptions([
    { value: 'Allow once!', label: 'L'.repeat(100), description: 'd'.repeat(300) },
    { value: 'Allow once?', label: 'Two', description: '' },
    { value: '', label: 'Three' }]);
  assert.equal(new Set(opts.map(o => o.value)).size, 3);
  for (const o of opts) {
    assert.match(o.value, /^[A-Za-z0-9_-]{1,128}$/);
    assert.ok([...o.label].length <= 60 && o.label.length > 0);
    assert.ok([...o.description].length <= 160);
    assert.deepEqual(Object.keys(o), ['value', 'label', 'description']);
  }
  assert.deepEqual(p.buildOptions('nope'), []);
  assert.equal(p.buildOptions(Array.from({ length: 50 }, (_, i) => ({ value: 'a', label: 'x' + i }))).length, 4);
});
test('describeTool: Bash first token only', () => {
  const d = p.describeTool('Bash', { command: 'git push https://x.com/?token=SECRET --force' }, { home: HOME });
  assert.equal(d, 'Bash: git');
  assert.equal(p.describeTool('Bash', { command: 'API_KEY=hunter2 TOKEN=z /usr/bin/curl -H x' }), 'Bash: curl');
  assert.equal(p.describeTool('Bash', { command: 'API_KEY=hunter2' }), 'Bash');
  assert.equal(p.describeTool('Bash', { command: '$(cat /etc/shadow)' }), 'Bash');
  assert.doesNotMatch(p.describeTool('Bash', { command: 'echo secret', env: { A: 'b' } }), /secret|env/);
});
test('describeTool: file tools basename only; no content/urls', () => {
  assert.equal(p.describeTool('Edit', { file_path: '/home/dev/p/src/app.ts', old_string: 'SECRET', new_string: 'S2' }), 'Edit: app.ts');
  assert.equal(p.describeTool('Write', { file_path: '/x/y/z.md', content: 'PRIVATE BODY' }), 'Write: z.md');
  assert.equal(p.describeTool('Read', { path: '/x/.env' }), 'Read: .env');
  const web = p.describeTool('WebFetch', { url: 'https://a.com/p?key=SECRET' });
  assert.doesNotMatch(web, /SECRET|a\.com|http/);
  assert.equal(p.describeTool('mcp__srv__do', { a: 1 }), 'mcp__srv__do');
});
test('describeTool: defensive', () => {
  const cyc = { command: 'ls' }; cyc.self = cyc;
  assert.equal(p.describeTool('Bash', cyc), 'Bash: ls');
  const hostile = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
  assert.equal(p.describeTool('Bash', hostile), 'Bash');
  assert.equal(p.describeTool('Bash', null), 'Bash');
  assert.equal(p.describeTool({}, 'x'), 'tool');
  assert.equal(p.describeTool('Bash\u0000; evil', {}), 'Bash-evil');
  const huge = p.describeTool('N'.repeat(10000), { command: 'x'.repeat(1e6) });
  assert.ok([...huge].length <= 100);
  assert.equal(p.describeTool('Bash', { command: 'a'.repeat(1e6) }), 'Bash');
  assert.ok(p.describeTool('Edit', { file_path: 'f'.repeat(1e6) }).length <= 100);
});

test('sanitizeText strips bidi/format/C1 and lone surrogates; describeTool hints too', () => {
  const spoof = ['\u200b', '\u200f', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\ufeff', '\u0080', '\u009f'];
  for (const ch of spoof) assert.equal(p.sanitizeText(`a${ch}b`, { max: 10 }), 'ab', ch.charCodeAt(0).toString(16));
  assert.equal(p.sanitizeText('a\ud800b\udc00c😀', { max: 10 }), 'abc😀');
  assert.equal(p.buildOptions([{ value: 'a', label: 'l\u202eab', description: 'd\u200bx' }])[0].label, 'lab');
  assert.equal(p.buildOptions([{ value: 'a', label: 'l', description: 'd\u200bx' }])[0].description, 'dx');
  assert.equal(p.describeTool('Edit', { file_path: '/tmp/\u202egpj.exe' }), 'Edit: gpj.exe');
  assert.equal(p.describeTool('Bash', { command: 'r\u200bm\u2060 -rf /' }), 'Bash: rm');
});

test('describeToolDetailed: lossy matrix', () => {
  const d = (n, i) => p.describeToolDetailed(n, i);
  const lossless = [['Bash', { command: 'ls' }], ['Bash', { command: ' ls ' }], ['mcp__srv__ping', {}], ['Bash', { command: 'ls -la' }], ['Bash', { command: 'rm -rf /' }],
    ['Bash', { command: 'ls;rm' }], ['Bash', { command: 'a|b' }], ['Bash', { command: '/bin/ls' }], ['Bash', { command: 'ls', description: 'x', timeout: 5 }]];
  for (const [n, i] of lossless) assert.equal(d(n, i).lossy, false, n + JSON.stringify(i));
  const lossy = [['Bash', { command: '$(x)' }], ['Bash', { command: 'ls\nrm' }], ['Bash', { command: '' }],
    ['Bash', { command: 'ls', env: 'x' }], ['Bash', {}], ['Bash', null], ['Bash', { command: 5 }],
    ['Write', { file_path: 'a.txt' }], ['Read', { file_path: '/etc/passwd' }], ['Edit', {}], ['mcp__srv__do', { a: 1 }], ['mcp__a__b__c', {}],
    ['Mystery', { a: 1 }], ['Mystery', 'str'], ['Mystery', [1]], ['Mystery', {}], ['Mystery', null]];
  for (const [n, i] of lossy) assert.equal(d(n, i).lossy, true, n + JSON.stringify(i));
  assert.equal(d('Bash', { command: 'ls' }).text, 'Bash: ls');
  assert.equal(d('Bash', { command: 'git status -s' }).text, 'Bash: git status -s');
  assert.equal(typeof d('Write', { file_path: '/a/b.txt' }).text, 'string');
});

test('describeToolDetailed: MCP lossless only with a plain empty object; unknown non-MCP always lossy', () => {
  const d = (n, i) => p.describeToolDetailed(n, i);
  assert.equal(d('mcp__a__b', {}).lossy, false);
  for (const i of [undefined, null, [], [1], 'x', '', 0, 5, true, { a: 1 }]) assert.equal(d('mcp__a__b', i).lossy, true, 'mcp ' + JSON.stringify(i));
  for (const n of ['WebFetch', 'Grep', 'Task', 'Mystery']) {
    for (const i of [undefined, null, [], 'x', 5, {}, { a: 1 }]) assert.equal(d(n, i).lossy, true, n + JSON.stringify(i));
  }
});

// HU-062 (found on Windows CI): the home contraction only knew '/home/...' and process.env.HOME, so on Windows the user's profile path
// (C:\Users\name, backslashes or slashes, any case) was shown in full on the island card.
test('sanitizeText contracts a Windows home (drive path, either separator, case-insensitive) and nothing else', () => {
  const p = require('../src/projection.cjs');
  const home = 'C:\\Users\\dev';
  assert.equal(p.sanitizeText('cat C:\\Users\\dev\\.ssh\\id_rsa', { max: 100, home }), 'cat ~\\.ssh\\id_rsa');
  assert.equal(p.sanitizeText('cat c:/users/dev/.ssh/id_rsa', { max: 100, home }), 'cat ~/.ssh/id_rsa');
  assert.equal(p.sanitizeText('cat C:\\Users\\devx\\a', { max: 100, home }), 'cat C:\\Users\\devx\\a', 'a longer name is not the home');
  assert.equal(p.sanitizeText('C:\\Users\\dev', { max: 100, home }), '~');
});

// Judge finding (HU-062): under Git Bash HOME is a POSIX-style path (/c/Users/dev) while the paths the tools print are C:\Users\dev;
// HOME must not hide USERPROFILE, so every candidate home is contracted.
test('sanitizeText tries every home candidate (HOME in Git Bash style does not hide USERPROFILE)', () => {
  const p = require('../src/projection.cjs');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = '/c/Users/dev'; process.env.USERPROFILE = 'C:\\Users\\dev';
    assert.equal(p.sanitizeText('cat C:\\Users\\dev\\.ssh\\id_rsa and /c/Users/dev/x'), 'cat ~\\.ssh\\id_rsa and ~/x');
    process.env.HOME = ''; 
    assert.equal(p.sanitizeText('cat C:\\Users\\dev\\a'), 'cat ~\\a');
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

'use strict';
const { test } = require('node:test');
const { unixOnly } = require('./platform-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractPlan, writeChannel, readPrevious, channelPath, previousPath, runPrevious, previousShell } = require('../src/statusline.cjs');

const NOW = 1_800_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'abito-sl-'));
const BIN = path.resolve(__dirname, '../bin/abito-statusline.cjs');

test('only the two windows survive; every other field of the status JSON is dropped', () => {
  const plan = extractPlan({
    cwd: '/secret/project', model: { id: 'x' }, transcript_path: '/t', session_id: 's',
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1_800_003_600, junk: 1 }, seven_day: { used_percentage: 40, resets_at: 1_800_500_000 }, extra: 'x' },
  }, NOW);
  assert.deepEqual(plan, { v: 1, at: NOW, five_hour: { used_percentage: 12.5, resets_at: 1_800_003_600 }, seven_day: { used_percentage: 40, resets_at: 1_800_500_000 } });
});

test('no limits, bad numbers or ms-in-disguise epochs give null', () => {
  for (const input of [null, 1, {}, { rate_limits: null }, { rate_limits: {} },
    { rate_limits: { five_hour: { used_percentage: 'a', resets_at: 1 } } },
    { rate_limits: { five_hour: { used_percentage: -1, resets_at: 1_800_003_600 } } },
    { rate_limits: { five_hour: { used_percentage: 201, resets_at: 1_800_003_600 } } },
    { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1_800_003_600_000 } } }]) {
    assert.equal(extractPlan(input, NOW), null, JSON.stringify(input));
  }
});

test('the channel is written 0600 atomically and holds the plan only', unixOnly('registered gap HU-062 (0600 channel privacy is the island runtime DACL on Windows)'), () => {
  const rt = tmp();
  const plan = extractPlan({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_800_003_600 } } }, NOW);
  assert.equal(writeChannel(rt, plan), true);
  const file = channelPath(rt);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), plan);
  assert.deepEqual(fs.readdirSync(rt), ['plan-claude.json']);
});

test('a symlink at the channel path is replaced, never written through', () => {
  const rt = tmp();
  const victim = path.join(tmp(), 'victim');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, channelPath(rt));
  const plan = extractPlan({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_800_003_600 } } }, NOW);
  assert.equal(writeChannel(rt, plan), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(channelPath(rt)).isFile(), true);
});

test('an unusable runtime directory fails quietly', () => {
  assert.equal(writeChannel('/nonexistent-abito-dir/x', { v: 1 }), false);
});

test('the previous status line is read only when well formed', () => {
  const home = tmp();
  assert.equal(readPrevious(home), null);
  fs.mkdirSync(path.dirname(previousPath(home)), { recursive: true });
  fs.writeFileSync(previousPath(home), JSON.stringify({ type: 'command', command: 'echo hi' }));
  assert.equal(readPrevious(home), 'echo hi');
  fs.writeFileSync(previousPath(home), JSON.stringify({ command: '  ' }));
  assert.equal(readPrevious(home), null);
  fs.writeFileSync(previousPath(home), 'not json');
  assert.equal(readPrevious(home), null);
});

test('the previous command gets the same stdin and its output is kept, capped and time-boxed', () => {
  assert.equal(runPrevious('cat', Buffer.from('hello'), 3000).toString(), 'hello');
  assert.equal(runPrevious('sleep 5; echo late', Buffer.from(''), 300), null);
  assert.ok(runPrevious('head -c 200000 /dev/zero', Buffer.from(''), 3000).length <= 64 * 1024);
});

test('the script prints the previous line untouched and writes the channel', () => {
  const rt = tmp();
  const home = tmp();
  fs.mkdirSync(path.dirname(previousPath(home)), { recursive: true });
  fs.writeFileSync(previousPath(home), JSON.stringify({ type: 'command', command: 'printf "[%s]" "$(head -c 5)"' }));
  const at = Math.floor(Date.now() / 1000);
  const input = JSON.stringify({ cwd: '/p', hello: 'world', rate_limits: { five_hour: { used_percentage: 3, resets_at: at + 3600 } } });
  const r = spawnSync(process.execPath, [BIN], { input, env: { ...process.env, ABITO_SOCKET_DIR: rt, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '[{"cwd]');
  const written = JSON.parse(fs.readFileSync(channelPath(rt), 'utf8'));
  assert.equal(written.five_hour.used_percentage, 3);
  assert.equal(JSON.stringify(written).includes('/p'), false);
});

test('garbage input or no runtime never fails the status line', () => {
  const r = spawnSync(process.execPath, [BIN], { input: 'not json', env: { PATH: process.env.PATH, HOME: tmp(), ABITO_SOCKET_DIR: '/nonexistent-abito-dir/x' }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// HU-062: the previous status line runs the way Claude Code runs it on each OS (docs: https://code.claude.com/docs/en/statusline,
// «Windows configuration»: Git Bash when installed, PowerShell otherwise). Pure resolver, platform + environment injected.
const W = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const only = (...files) => p => files.includes(p);
test('previousShell: Unix keeps /bin/sh -c', () => {
  for (const platform of ['linux', 'darwin']) assert.deepEqual(previousShell({ platform, env: {} }), { file: '/bin/sh', args: ['-c'] });
});
test('previousShell (Windows): CLAUDE_CODE_GIT_BASH_PATH first, only if absolute and an existing bash.exe', () => {
  const custom = 'D:\\tools\\git\\bin\\bash.exe';
  const exists = only(custom, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(previousShell({ platform: 'win32', env: { ...W, CLAUDE_CODE_GIT_BASH_PATH: custom }, exists }), { file: custom, args: ['-c'] });
  for (const bad of ['bash.exe', '..\\bash.exe', 'D:\\tools\\git\\bin\\evil.exe', 'D:\\missing\\bash.exe', '\\\\srv\\s\\bash.exe', '']) {
    assert.deepEqual(previousShell({ platform: 'win32', env: { ...W, CLAUDE_CODE_GIT_BASH_PATH: bad }, exists }), { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] }, bad);
  }
});
test('previousShell (Windows): Program Files then Program Files (x86), then PowerShell by absolute path; never PATH', () => {
  const x86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
  assert.deepEqual(previousShell({ platform: 'win32', env: W, exists: only(x86) }), { file: x86, args: ['-c'] });
  assert.deepEqual(previousShell({ platform: 'win32', env: { ...W, PATH: 'C:\\evil' }, exists: only(PS) }), { file: PS, args: ['-NoProfile', '-NonInteractive', '-Command'] });
  assert.equal(previousShell({ platform: 'win32', env: { ...W, SystemRoot: 'relative' }, exists: () => false }), null, 'no absolute SystemRoot => nothing runs');
  assert.equal(previousShell({ platform: 'win32', env: W, exists: () => false }), null, 'nothing found => nothing runs');
});
test('Windows twin: the previous command really runs through Git Bash, and through PowerShell when no Git Bash is found', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  assert.equal(runPrevious('cat', Buffer.from('hello'), 5000).toString(), 'hello');
  const noGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(claude_code_git_bash_path|programfiles|programfiles\(x86\))$/i.test(k)));
  Object.assign(noGit, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\no\\such\\bash.exe', ProgramFiles: 'C:\\no-pf', 'ProgramFiles(x86)': 'C:\\no-pf86' });
  assert.match(previousShell({ platform: 'win32', env: noGit })?.file ?? '', /powershell\.exe$/i, 'PowerShell branch selected');
  assert.equal(runPrevious("Write-Output 'ps-ok'", Buffer.from(''), 15000, { env: noGit }).toString().trim(), 'ps-ok');
});

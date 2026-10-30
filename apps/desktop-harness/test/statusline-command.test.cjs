'use strict';
// HU-062 (product bug found reviewing the Windows run): the installed statusLine command was cmd-style («"C:\…\node.exe" "C:\…\x.cjs"»), but Claude Code
// runs it through Git Bash (backslashes eaten) or PowerShell (a leading quoted path is a string expression, so it needs `& `). The command is built
// for the shell Claude Code will really use, chosen by the same resolver as the relay's previous-command runner (previousShell).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpBase } = require('./platform-env.cjs');
const winfs = require('../src/win-fs.cjs');
const { statusLineCommand, planStatusLine } = require('../src/install-statusline.cjs');
const { runPrevious, previousShell } = require('../src/statusline.cjs');
const { fakeBackend } = require('./win-fake-backend.cjs');

const BASH = { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] };
const PS = { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
const NODE = 'C:\\Program Files\\nodejs\\node.exe', BIN = 'C:\\Program Files\\Abito\\desktop-harness\\bin\\abito-statusline.cjs';

test('Git Bash form uses forward slashes; PowerShell form starts with the call operator and keeps backslashes', () => {
  assert.equal(statusLineCommand(NODE, BIN, BASH), '"C:/Program Files/nodejs/node.exe" "C:/Program Files/Abito/desktop-harness/bin/abito-statusline.cjs"');
  assert.equal(statusLineCommand(NODE, BIN, PS), `& "${NODE}" "${BIN}"`);
});
test('L6 refusals stay and `$` / backtick are refused too; no shell found => refuse, nothing generated', () => {
  for (const shell of [BASH, PS]) for (const bad of ['C:\\a"b\\n.exe', 'C:\\a%PATH%\\n.exe', 'C:\\a&b\\n.exe', 'C:\\a$b\\n.exe', 'C:\\a`b\\n.exe', 'rel\\n.exe', 'C:\\a\nb\\n.exe']) {
    assert.throws(() => statusLineCommand(bad, BIN, shell), /unsafe/, bad);
  }
  assert.throws(() => statusLineCommand(NODE, BIN, null), /no shell/);
});
function plan(file, shell) { return planStatusLine({ settingsPath: file, execPath: NODE, binPath: BIN, uid: 'win', shell }); }
test('a command installed for the other shell is `replace` (the UI row says Desactualizado and offers reinstall); the same shell is unchanged', t => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-slc-'))); fs.chmodSync(d, 0o700);
  t.after(() => { winfs.useForTests(null); fs.rmSync(d, { recursive: true, force: true }); });
  if (process.platform !== 'win32') winfs.useForTests(fakeBackend()); // Windows: the REAL helper (the fake judges POSIX modes)
  const file = path.join(d, 'settings.json');
  const first = plan(file, BASH);
  assert.equal(first.action, 'add');
  fs.writeFileSync(file, first.after, { mode: 0o600 });
  assert.equal(plan(file, BASH).action, 'unchanged');
  assert.equal(plan(file, BASH).changed, false);
  const other = plan(file, PS);
  assert.equal(other.action, 'replace'); assert.equal(other.changed, true);
  assert.ok(JSON.parse(other.after).statusLine.command.startsWith('& "'));
});
test('Windows twin: both generated forms really execute (through Git Bash and through PowerShell), reading stdin and printing', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpBase(), 'abito-slx-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'echo-stdin.cjs');
  fs.writeFileSync(script, "process.stdin.on('data', d => process.stdout.write('got:' + d));");
  const withoutGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(claude_code_git_bash_path|programfiles|programfiles\(x86\))$/i.test(k)));
  Object.assign(withoutGit, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\no\\such\\bash.exe', ProgramFiles: 'C:\\no-pf', 'ProgramFiles(x86)': 'C:\\no-pf86' });
  const bash = previousShell(), ps = previousShell({ env: withoutGit });
  assert.match(bash?.file ?? '', /bash\.exe$/i, 'Git Bash is on the runner'); assert.match(ps?.file ?? '', /powershell\.exe$/i);
  assert.equal(runPrevious(statusLineCommand(process.execPath, script, bash), Buffer.from('hi'), 20000).toString(), 'got:hi');
  assert.equal(runPrevious(statusLineCommand(process.execPath, script, ps), Buffer.from('hi'), 30000, { env: withoutGit }).toString(), 'got:hi');
});

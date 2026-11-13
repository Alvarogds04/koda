'use strict';
const { tmpBase, assertMode } = require('./platform-env.cjs');
// macOS: tmpBase() is /var/folders/... and /var is a symlink to /private/var; the installers refuse a settings path that contains a
// symlink (correct for a real home), so the fixture home is canonicalized (as the other install tests already do).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planStatusLine, runStatusLineInstall, STATUSLINE_BIN, isOurs } = require('../src/install-statusline.cjs');

const uid = process.getuid?.();
function home(settings) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-isl-')));
  fs.mkdirSync(path.join(h, '.claude'));
  const file = path.join(h, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(file, settings, { mode: 0o600 });
  return { h, file, prev: path.join(h, '.abito', 'statusline-previous.json') };
}
let tick = 0;
const run = async (argv, t, extra = {}) => {
  let out = '', err = '';
  const code = await runStatusLineInstall(argv, { out: s => { out += s; }, err: s => { err += s; }, env: { HOME: t.h }, homedir: () => t.h, isTTY: () => true,
    prompt: async () => (argv.includes('--remove') ? 'remove' : 'install'), now: () => new Date(Date.UTC(2026, 9, 18, 12, 0, 0, tick++)), execPath: process.platform === 'win32' ? process.execPath : '/usr/bin/node', ...extra });
  return { code, out, err };
};

test('preview is the default: it prints the diff and writes nothing', async () => {
  const t = home('{\n  "model": "x"\n}\n');
  const before = fs.readFileSync(t.file, 'utf8');
  const r = await run(['--user'], t);
  assert.equal(r.code, 0);
  assert.match(r.out, /dry run: nothing was written/);
  assert.match(r.out, /\+.*statusLine/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), before);
  assert.equal(fs.existsSync(t.prev), false);
});

test('apply adds only the statusLine member, makes a dated backup and keeps every other byte', async () => {
  const t = home('{\n  "model": "x",\n  "hooks": { "Stop": [] }\n}\n');
  const original = fs.readFileSync(t.file, 'utf8');
  const r = await run(['--user', '--apply'], t);
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  assert.equal(parsed.model, 'x');
  assert.deepEqual(parsed.hooks, { Stop: [] });
  assert.equal(parsed.statusLine.type, 'command');
  assert.ok(isOurs(parsed.statusLine));
  assert.ok(parsed.statusLine.command.includes(process.platform === 'win32' ? STATUSLINE_BIN.replace(/\\/g, '/') : STATUSLINE_BIN)); // Windows: Git Bash form uses forward slashes (statusline-command.test.cjs covers both shells)
  const backups = fs.readdirSync(path.dirname(t.file)).filter(n => n.includes('.abito-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(t.file), backups[0]), 'utf8'), original);
  assert.equal(fs.existsSync(t.prev), false);
});

test('the user\'s own status line is saved, keeps its other keys, and comes back on remove', async () => {
  const t = home('{\n  "statusLine": { "type": "command", "command": "~/bin/mine.sh", "padding": 2 },\n  "model": "x"\n}\n');
  const original = fs.readFileSync(t.file, 'utf8');
  assert.equal((await run(['--user', '--apply'], t)).code, 0);
  const installed = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  assert.equal(installed.statusLine.padding, 2);
  assert.ok(isOurs(installed.statusLine));
  assert.equal(JSON.parse(fs.readFileSync(t.prev, 'utf8')).command, '~/bin/mine.sh');
  assertMode(t.prev, 0o600);
  assert.equal((await run(['--user', '--remove', '--apply'], t)).code, 0);
  assert.equal(fs.readFileSync(t.file, 'utf8'), original);
  assert.equal(fs.existsSync(t.prev), false);
});

test('remove with no previous status line drops the key and only ours', async () => {
  const t = home('{\n  "model": "x"\n}\n');
  assert.equal((await run(['--user', '--apply'], t)).code, 0);
  assert.equal((await run(['--user', '--remove', '--apply'], t)).code, 0);
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{\n  "model": "x"\n}\n');
});

test('remove leaves a status line that is no longer ours alone', async () => {
  const t = home('{\n  "statusLine": { "type": "command", "command": "other" }\n}\n');
  const r = await run(['--user', '--remove', '--apply'], t);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to change/);
  assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).statusLine.command, 'other');
});

test('installing twice is a no-op and never overwrites the saved previous line with ours', async () => {
  const t = home('{ "statusLine": { "type": "command", "command": "mine" } }\n');
  await run(['--user', '--apply'], t);
  const r = await run(['--user', '--apply'], t);
  assert.match(r.out, /Nothing to change/);
  assert.equal(JSON.parse(fs.readFileSync(t.prev, 'utf8')).command, 'mine');
});

test('refusals write nothing: non-object statusLine, duplicate keys, symlink, not strict JSON', async () => {
  for (const text of ['{ "statusLine": "x" }', '{ "statusLine": {}, "statusLine": {} }', '{ // c\n}', '[]']) {
    const t = home(text);
    const r = await run(['--user', '--apply'], t);
    assert.notEqual(r.code, 0, text);
    assert.equal(fs.readFileSync(t.file, 'utf8'), text);
    assert.equal(fs.existsSync(t.prev), false);
  }
  const t = home(undefined);
  const real = path.join(t.h, 'real.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, t.file);
  assert.equal((await run(['--user', '--apply'], t)).code, 65);
  assert.equal(fs.readFileSync(real, 'utf8'), '{}');
});

test('apply needs a terminal and the typed word; anything else aborts with nothing written', async () => {
  const t = home('{}\n');
  assert.equal((await run(['--user', '--apply'], t, { isTTY: () => false })).code, 77);
  assert.equal((await run(['--user', '--apply'], t, { prompt: async () => 'yes' })).code, 1);
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{}\n');
  assert.equal(fs.existsSync(t.prev), false);
});

test('a missing file is created 0600 and removed again without leaving an empty junk file behind in the saved copy', async () => {
  const t = home(undefined);
  assert.equal((await run(['--user', '--apply'], t)).code, 0);
  assertMode(t.file, 0o600);
  assert.equal(planStatusLine({ settingsPath: t.file, remove: false, uid, execPath: process.platform === 'win32' ? process.execPath : '/usr/bin/node' }).changed, false);
});

test('bad arguments are a usage error', async () => {
  const t = home('{}\n');
  for (const argv of [[], ['--user', '--timeout-sec', '5'], ['--user', '--user'], ['--settings', 'rel']]) assert.equal((await run(argv, t)).code, 64, JSON.stringify(argv));
});

// --- K2-04 (S1, S4): the Koda 0.1 status line is ours too -------------------------------------
// A 0.1 install pointed statusLine at `bin/abito-statusline.cjs`. It is replaced in place (statusLine is a single member, so there
// is never a second relay) and `--remove` takes it out — the user's own status line keeps being saved and restored as before.

const LEGACY_CMD = "'/usr/bin/node' '/opt/koda-0.1/desktop-harness/bin/abito-statusline.cjs'";

test('K2-04: a 0.1 status line is replaced in place and the installed one names the Koda script', async () => {
  const t0 = home(`{\n  "statusLine": {"type": "command", "command": ${JSON.stringify(LEGACY_CMD)}}\n}\n`);
  // On Windows the installer only quotes an absolute drive path, so the test uses the real node executable on every OS.
  const pl = planStatusLine({ settingsPath: t0.file, home: t0.h, binPath: STATUSLINE_BIN, execPath: process.execPath });
  assert.equal(pl.action, 'replace', 'the 0.1 relay is recognised as ours');
  assert.ok(pl.after.includes('koda-statusline.cjs'), 'the new relay names the Koda script');
  assert.ok(!pl.after.includes('abito-statusline.cjs'), 'and no 0.1 name survives');
  const applied = await run(['--settings', t0.file, '--apply'], t0);
  assert.equal(applied.code, 0, applied.err);
  const text = fs.readFileSync(t0.file, 'utf8');
  assert.equal((text.match(/"statusLine"/g) || []).length, 1, 'exactly one status-line member');
  assert.ok(text.includes('koda-statusline.cjs'));
  // remove: the 0.1 relay is ours, so it is taken out with no saved previous line
  const removed = await run(['--settings', t0.file, '--remove', '--apply'], t0);
  assert.equal(removed.code, 0, removed.err);
  assert.ok(!fs.readFileSync(t0.file, 'utf8').includes('statusLine'));
});

test('K2-04: both markers are ours, a foreign status line is not', () => {
  assert.equal(isOurs({ type: 'command', command: "'/usr/bin/node' '/x/koda-statusline.cjs'" }), true);
  assert.equal(isOurs({ type: 'command', command: `'/usr/bin/node' '/x/abito-statusline.cjs'` }), true, 'the 0.1 relay stays removable');
  assert.equal(isOurs({ type: 'command', command: 'my-own-statusline --flag' }), false);
});

test('K2-04: the recogniser is anchored on the exact script name, so a look-alike status line is foreign', () => {
  const node = '/usr/bin/node';
  const ours = d => isOurs({ type: 'command', command: `'${node}' '${d}'` });
  assert.equal(ours('/opt/koda/bin/koda-statusline.cjs'), true);
  assert.equal(ours('/Users/a/Abito.app/Contents/Resources/desktop-harness/bin/abito-statusline.cjs'), true);
  assert.equal(isOurs({ type: 'command', command: '& "C:\\Program Files\\nodejs\\node.exe" "C:\\k\\bin\\koda-statusline.cjs"' }), true);
  for (const d of ['/home/me/my-abito-statusline.cjs', '/home/me/koda-statusline.cjs.bak', '/home/me/koda-statusline.cjs/run.sh', '/home/me/not-koda-statusline.cjs']) {
    assert.equal(ours(d), false, d);
  }
  assert.equal(isOurs({ type: 'command', command: 'my-status --wrap koda-statusline.cjs' }), false, 'a bare mention inside another command');
});

test('K2-04: an unquoted script path is ours when it has a path separator; a bare name inside another command is not', () => {
  assert.equal(isOurs({ type: 'command', command: 'node /x/koda-statusline.cjs' }), true);
  assert.equal(isOurs({ type: 'command', command: 'node /opt/old/abito-statusline.cjs' }), true);
  assert.equal(isOurs({ type: 'command', command: 'node C:\\x\\koda-statusline.cjs' }), true);
  assert.equal(isOurs({ type: 'command', command: 'node /x/my-abito-statusline.cjs' }), false, 'look-alike');
  assert.equal(isOurs({ type: 'command', command: 'my-status --wrap koda-statusline.cjs' }), false, 'a bare name is not a path');
});

test('K2-04: a foreign status line is never ours, even when it carries our script path as an argument', () => {
  const foreign = [
    'node /x/old/abito-statusline.cjs && rm -rf ~',
    '/usr/bin/foreign-statusline /x/koda-statusline.cjs',
    'cat /x/koda-statusline.cjs',
    'echo x>/x/koda-statusline.cjs',
    'my-status --config=/x/koda-statusline.cjs',
    "bash -c 'echo /x/koda-statusline.cjs'",
    "my-status --wrap 'koda-statusline.cjs'",
    "node '/x/koda-statusline.cjs' --extra",
    'node /x/koda-statusline.cjs; rm -rf ~',
    'FOO=1 node /x/koda-statusline.cjs',
  ];
  for (const command of foreign) assert.equal(isOurs({ type: 'command', command }), false, command);
});

test('K2-04: the exact shapes the installers write are still ours (Unix, Git Bash, PowerShell, 0.1)', () => {
  const ours = [
    "'/usr/bin/node' '/opt/koda/bin/koda-statusline.cjs'",
    "'/usr/bin/node' '/Users/a/Abito.app/Contents/Resources/desktop-harness/bin/abito-statusline.cjs'",
    '"C:/Program Files/nodejs/node.exe" "C:/k/bin/koda-statusline.cjs"',
    '& "C:\\Program Files\\nodejs\\node.exe" "C:\\k\\bin\\koda-statusline.cjs"',
    'node /x/koda-statusline.cjs',
    'node C:\\x\\koda-statusline.cjs',
  ];
  for (const command of ours) assert.equal(isOurs({ type: 'command', command }), true, command);
});

test("K2-04: the line the installer writes is ours even when a path holds an apostrophe (shq escapes it)", () => {
  const { shq } = require('../src/install-claude.cjs');
  for (const [node, script] of [["/home/o'brien/bin/node", '/opt/koda/bin/koda-statusline.cjs'], ['/usr/bin/node', "/home/o'brien/koda/bin/koda-statusline.cjs"], ["/o'b/node", "/o'b/bin/abito-statusline.cjs"]]) {
    const command = `${shq(node)} ${shq(script)}`;
    assert.equal(isOurs({ type: 'command', command }), true, command);
  }
  assert.equal(isOurs({ type: 'command', command: `${shq("/o'b/node")} ${shq('/x/my-koda-statusline.cjs')}` }), false, 'a look-alike with an apostrophe is still foreign');
});

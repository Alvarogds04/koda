'use strict';
const { tmpBase } = require('./platform-env.cjs');
// macOS: tmpBase() is /var/folders/... and /var is a symlink to /private/var; the installers refuse a settings path that contains a
// symlink (correct for a real home), so the fixture home is canonicalized (as the other install tests already do).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRecapInstall, RECAP_BIN } = require('../src/install-recap.cjs');

let tick = 0;
function home(settings) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-irc-')));
  fs.mkdirSync(path.join(h, '.claude'));
  const file = path.join(h, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(file, settings, { mode: 0o600 });
  return { h, file };
}
const run = async (argv, t, extra = {}) => {
  let out = '', err = '';
  const code = await runRecapInstall(argv, { out: s => { out += s; }, err: s => { err += s; }, env: { HOME: t.h }, homedir: () => t.h, isTTY: () => true, execPath: '/usr/bin/node',
    prompt: async () => (argv.includes('--remove') ? 'remove' : 'install'), now: () => new Date(Date.UTC(2026, 9, 18, 12, 0, 0, tick++)), ...extra });
  return { code, out, err };
};

test('preview is the default and writes nothing', async () => {
  const t = home('{\n  "model": "x"\n}\n');
  const before = fs.readFileSync(t.file, 'utf8');
  const r = await run(['--user'], t);
  assert.equal(r.code, 0);
  assert.match(r.out, /dry run: nothing was written/);
  assert.match(r.out, /hooks\.PostToolUse: add/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), before);
});

test('apply adds the three notify-only events next to the user\'s own hooks and the permission/stop hooks', async () => {
  const t = home(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }] }, model: 'x' }, null, 2) + '\n');
  const r = await run(['--user', '--apply'], t);
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  assert.equal(parsed.model, 'x');
  for (const ev of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    assert.ok(parsed.hooks[ev].some(g => g.hooks.some(h => Array.isArray(h.args) && h.args.includes(RECAP_BIN))), ev);
  }
  assert.ok(parsed.hooks.Stop.some(g => g.hooks.some(h => h.command === 'mine')));
  assert.ok(parsed.hooks.PostToolUse.some(g => g.hooks.some(h => h.command === 'theirs')));
  assert.equal(fs.readdirSync(path.dirname(t.file)).filter(n => n.includes('.abito-backup-')).length, 1);
});

test('remove takes out only our entries and restores the rest; a second install is a no-op', async () => {
  const t = home('{\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "mine" }] }]\n  }\n}\n');
  await run(['--user', '--apply'], t);
  assert.match((await run(['--user', '--apply'], t)).out, /Nothing to change/);
  assert.equal((await run(['--user', '--remove', '--apply'], t)).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.file, 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } });
});

test('it needs a terminal and the typed word, and --timeout-sec is not accepted', async () => {
  const t = home('{}\n');
  assert.equal((await run(['--user', '--apply'], t, { isTTY: () => false })).code, 77);
  assert.equal((await run(['--user', '--apply'], t, { prompt: async () => 'no' })).code, 1);
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{}\n');
  assert.equal((await run(['--user', '--timeout-sec', '9'], t)).code, 64);
});

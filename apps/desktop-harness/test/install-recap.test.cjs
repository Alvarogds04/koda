'use strict';
const { tmpBase } = require('./platform-env.cjs');
// K2-03 T3 (S2, S4): Recap is removed in 0.2. `abito-hook install recap` survives only as a REMOVAL-ONLY legacy profile so
// an upgraded Koda can take the 0.1 recap hooks out of ~/.claude/settings.json (otherwise Claude Code keeps calling a
// deleted script). It can never install them again. Unrelated hooks and keys stay byte-identical; a backup comes first.
// TODO(K2-03 follow-up): remove one version after K2-03 ships, together with src/install-recap.cjs.
// macOS: tmpBase() is /var/folders/... behind the /var -> /private/var link, so the fixture home is canonicalized.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runRecapInstall } = require('../src/install-recap.cjs');
const ui = require('../src/install-ui.cjs');

// What Koda 0.1 wrote: three recap entries pointing at ITS install of the (now deleted) hook script, next to the user's
// own hooks, the Claude permission hook and the status-line relay.
const OLD_BIN = path.join(path.sep === '\\' ? 'C:\\Koda-0.1' : '/opt/koda-0.1', 'desktop-harness', 'bin', 'abito-recap-hook.cjs');
const recapEntry = { hooks: [{ type: 'command', command: '/usr/bin/node', args: [OLD_BIN], timeout: 5 }] };
const keep = {
  model: 'opus',
  statusLine: { type: 'command', command: '/usr/bin/node', args: ['/opt/koda-0.1/desktop-harness/bin/abito-statusline.cjs'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: '/usr/bin/node', args: ['/opt/koda-0.1/desktop-harness/bin/abito-hook.cjs', 'claude', 'permission-request'] }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }],
  },
};
const withRecap = () => {
  const s = JSON.parse(JSON.stringify(keep));
  s.hooks.Stop.push(recapEntry); s.hooks.PostToolUse.push(recapEntry); s.hooks.UserPromptSubmit = [recapEntry];
  return JSON.stringify(s, null, 2) + '\n';
};
const backups = file => fs.readdirSync(path.dirname(file)).filter(n => n.includes('.abito-backup-'));

let tick = 0;
function home(settings) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-irc-')));
  fs.mkdirSync(path.join(h, '.claude'));
  const file = path.join(h, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(file, settings, { mode: 0o600 });
  return { h, file };
}
const run = async (argv, t) => {
  let out = '', err = '';
  const code = await runRecapInstall(argv, { out: s => { out += s; }, err: s => { err += s; }, env: { HOME: t.h, USERPROFILE: t.h }, homedir: () => t.h, isTTY: () => true, execPath: '/usr/bin/node',
    prompt: async () => (argv.includes('--remove') ? 'remove' : 'install'), now: () => new Date(Date.UTC(2026, 10, 3, 12, 0, 0, tick++)) });
  return { code, out, err };
};

test('install is refused: Recap can never be added again (exit 64, file and folder untouched)', async () => {
  const t = home(JSON.stringify(keep));
  const before = fs.readFileSync(t.file);
  for (const argv of [['--user'], ['--user', '--apply']]) {
    const r = await run(argv, t);
    assert.equal(r.code, 64, argv.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, /usage: abito-hook install recap --user --remove/);
  }
  assert.deepEqual(fs.readFileSync(t.file), before);
  assert.deepEqual(backups(t.file), []);
});

test('remove takes out exactly the 0.1 recap entries; every other hook and key is unchanged; a backup of the original comes first', async () => {
  const t = home(withRecap());
  const original = fs.readFileSync(t.file, 'utf8');
  const r = await run(['--user', '--remove', '--apply'], t);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(t.file, 'utf8'), JSON.stringify(keep, null, 2) + '\n', 'only the recap entries went, byte for byte');
  const made = backups(t.file);
  assert.equal(made.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(t.file), made[0]), 'utf8'), original, 'the backup is the original');
});

test('a settings file without recap entries is not rewritten and gets no backup; a second removal is a no-op', async () => {
  const t = home(withRecap());
  assert.equal((await run(['--user', '--remove', '--apply'], t)).code, 0);
  const after = fs.readFileSync(t.file);
  const r = await run(['--user', '--remove', '--apply'], t);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readFileSync(t.file), after);
  assert.equal(backups(t.file).length, 1, 'no new backup');
  const clean = home(JSON.stringify(keep));
  const bytes = fs.readFileSync(clean.file);
  assert.equal((await run(['--user', '--remove', '--apply'], clean)).code, 0);
  assert.deepEqual(fs.readFileSync(clean.file), bytes);
  assert.deepEqual(backups(clean.file), []);
});

test('an unparseable settings file is refused and left alone', async () => {
  const t = home('{"hooks": {"Stop": [ }');
  const before = fs.readFileSync(t.file);
  const r = await run(['--user', '--remove', '--apply'], t);
  assert.notEqual(r.code, 0);
  assert.deepEqual(fs.readFileSync(t.file), before);
  assert.deepEqual(backups(t.file), []);
});

test('island --json path: recap previews a REMOVAL only; an install preview is a usage error', async () => {
  const t = home(withRecap());
  const before = fs.readFileSync(t.file);
  const call = async argv => { const lines = []; const code = await ui.runInstallUi(argv, { out: s => lines.push(s), env: { HOME: t.h, USERPROFILE: t.h }, homedir: () => t.h }); return { code, json: JSON.parse(lines[0]) }; };
  const install = await call(['recap', '--user', '--json']);
  assert.equal(install.code, 64); assert.equal(install.json.code, 'usage');
  const rm = await call(['recap', '--user', '--remove', '--json']);
  assert.equal(rm.code, 0);
  assert.equal(rm.json.changed, true);
  assert.deepEqual(rm.json.entries, [{ event: 'UserPromptSubmit', op: 'remove' }, { event: 'PostToolUse', op: 'remove' }, { event: 'Stop', op: 'remove' }]);
  assert.deepEqual(fs.readFileSync(t.file), before, 'a preview writes nothing');
});

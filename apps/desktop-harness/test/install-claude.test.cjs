'use strict';
const { tmpBase, assertMode, unixOnly } = require('./platform-env.cjs');
// Every test uses a private mkdtemp (0700) directory under tmpBase(); the real ~/.claude is never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ic = require('../src/install-claude.cjs');

const BIN = path.resolve(__dirname, '../bin/abito-hook.cjs');
const EXEC = process.execPath;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-instclaude-')));
  fs.chmodSync(d, 0o700);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const plan = (p, o = {}) => ic.planClaudeSettings({ settingsPath: p, ...o });
const herdr = { type: 'command', command: '/usr/bin/herdr-hook', args: ['x'] };
const other = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/other-tool', timeout: 5 }] };
function io(extra = {}) {
  const r = { out: '', err: '', prompts: [] };
  r.opts = {
    out: s => { r.out += s; }, err: s => { r.err += s; }, isTTY: () => true, uid: process.getuid?.(),
    prompt: async q => { r.prompts.push(q); return 'install'; }, now: () => new Date('2026-01-02T03:04:05.678Z'), ...extra,
  };
  return r;
}
const ls = d => fs.readdirSync(d).sort();
function write(d, obj, indent = 2, nl = true, mode = 0o640) {
  const p = path.join(d, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, indent) + (nl ? '\n' : ''), { mode });
  fs.chmodSync(p, mode);
  return p;
}
const ours = obj => JSON.stringify(obj).includes(JSON.stringify(BIN).slice(1, -1)); // JSON escapes Windows backslashes

test('planner: absent file => {} plus our two events, nothing written', t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  const pl = plan(p);
  assert.equal(pl.exists, false);
  assert.deepEqual(ls(d), []);
  const h = JSON.parse(pl.after).hooks;
  assert.deepEqual(h.PermissionRequest, [{ hooks: [{ type: 'command', command: EXEC, args: [BIN, 'claude', 'permission-request', '--timeout-sec', '35'], timeout: 35 }] }]);
  assert.deepEqual(h.Stop, [{ hooks: [{ type: 'command', command: EXEC, args: [BIN, 'claude', 'stop'], timeout: 15 }] }]);
  assert.deepEqual(Object.keys(h).sort(), ['PermissionRequest', 'SessionStart', 'Stop'], 'S2: no PreToolUse entry is installed any more');
  assert.equal(h.PermissionRequest[0].matcher, undefined, 'ONE PermissionRequest handler, no matcher: it sees every tool, AskUserQuestion included');
  assert.equal(pl.after.endsWith('\n'), true);
  assert.ok(path.isAbsolute(JSON.parse(pl.after).hooks.Stop[0].hooks[0].args[0]));
});

test('planner: timeout equals --timeout-sec and is validated', t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  const e = JSON.parse(plan(p, { timeoutSec: 50 }).after).hooks.PermissionRequest[0].hooks[0];
  assert.equal(e.timeout, 50); assert.deepEqual(e.args.slice(-2), ['--timeout-sec', '50']);
  for (const bad of [0, 3601, 1.5, '35', NaN]) assert.throws(() => plan(p, { timeoutSec: bad }), e => e.exitCode === 64);
});

test('planner: preserves other tools, other events and SessionStart; idempotent; replace on timeout change', t => {
  const d = tmp(t);
  const orig = { theme: 'dark', permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ hooks: [herdr] }], PermissionRequest: [other], Notification: [other] } };
  const p = write(d, orig);
  const one = plan(p);
  const o1 = JSON.parse(one.after);
  assert.deepEqual(o1.hooks.SessionStart[0], orig.hooks.SessionStart[0], 'the human\'s own SessionStart hook stays first and untouched');
  assert.equal(o1.hooks.SessionStart.length, 2);
  assert.equal(o1.hooks.PreToolUse, undefined, 'S2: the PreToolUse/AskUserQuestion entry is not installed any more');
  assert.deepEqual(o1.hooks.SessionStart[1].hooks[0].args.slice(1), ['claude', 'session-start']);
  assert.equal(o1.hooks.SessionStart[1].hooks[0].timeout, 5);
  assert.equal(o1.hooks.SessionStart[1].matcher, undefined);
  assert.deepEqual(o1.hooks.Notification, orig.hooks.Notification);
  assert.deepEqual(o1.hooks.PermissionRequest[0], other);
  assert.equal(o1.hooks.PermissionRequest.length, 2);
  assert.equal(o1.theme, 'dark'); assert.deepEqual(o1.permissions, orig.permissions);
  fs.writeFileSync(p, one.after);
  const two = plan(p);
  assert.equal(two.after, one.after); assert.equal(two.changed, false);
  const three = plan(p, { timeoutSec: 60 });
  const o3 = JSON.parse(three.after);
  assert.equal(o3.hooks.PermissionRequest.length, 2);
  assert.equal(o3.hooks.PermissionRequest[1].hooks[0].timeout, 60);
  assert.ok(three.actions.some(a => a.action === 'replace'));
  assert.equal(JSON.stringify(o3).split(JSON.stringify(BIN).slice(1, -1)).length - 1, 3, 'PermissionRequest, SessionStart, Stop');
});

// ---- S2 migration: the Koda-owned PreToolUse/AskUserQuestion entry is removed, nothing else is touched ----
const oldOwned = (timeout = 35) => ({ matcher: 'AskUserQuestion',
  hooks: [{ type: 'command', command: EXEC, args: [BIN, 'claude', 'pre-tool-use', '--timeout-sec', String(timeout)], timeout }] });
const foreignPre = { matcher: 'Edit', hooks: [{ type: 'command', command: '/opt/mine', timeout: 5 }] };

test('migration: removes our old owned PreToolUse entry, keeps a foreign one, then a second run is a no-op', t => {
  const d = tmp(t);
  const p = write(d, { theme: 'dark', hooks: { PreToolUse: [foreignPre, oldOwned()], Notification: [other] } });
  const one = plan(p);
  const o1 = JSON.parse(one.after);
  assert.deepEqual(o1.hooks.PreToolUse, [foreignPre], 'only the entry whose command is ours is removed');
  assert.deepEqual(o1.hooks.Notification, [other]);
  assert.equal(o1.theme, 'dark');
  assert.ok(one.actions.some(a => a.event === 'PreToolUse' && a.action === 'remove'));
  assert.equal(one.changed, true);
  fs.writeFileSync(p, one.after);
  const two = plan(p);
  assert.equal(two.after, one.after); assert.equal(two.changed, false);
  assert.equal(two.actions.find(a => a.event === 'PreToolUse'), undefined, 'a migration with nothing to remove is not reported');
  assert.equal(two.patch, null);
});

test('migration: an emptied Abito matcher group disappears; ours is picked out of a shared group', t => {
  const d = tmp(t);
  const p = write(d, { hooks: { PreToolUse: [oldOwned()] } });
  const after = JSON.parse(plan(p).after);
  assert.equal(after.hooks.PreToolUse, undefined, 'the matcher group we emptied is dropped');
  assert.equal(after.hooks.PermissionRequest.length, 1);
  const p2 = write(d, { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [foreignPre.hooks[0], oldOwned().hooks[0]] }] } });
  assert.deepEqual(JSON.parse(plan(p2).after).hooks.PreToolUse, [{ matcher: 'AskUserQuestion', hooks: [foreignPre.hooks[0]] }]);
});

test('migration: never installs PreToolUse, and --remove never recreates it', t => {
  const d = tmp(t);
  const p = write(d, { hooks: { PreToolUse: [oldOwned()] } });
  fs.writeFileSync(p, plan(p).after);
  assert.equal(ours(JSON.parse(fs.readFileSync(p, 'utf8'))), true);
  const back = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(back.after), {});
  assert.equal(ours(JSON.parse(back.after)), false);
});

test('migration: verification refuses an install where the old owned entry survived', t => {
  const d = tmp(t);
  const p = write(d, { hooks: { PreToolUse: [oldOwned()] } });
  const pl = plan(p);
  assert.equal(ic.defaultVerify(JSON.parse(pl.after), pl, pl.after), true);
  const tampered = JSON.parse(pl.after);
  tampered.hooks.PreToolUse = [oldOwned()];
  assert.equal(ic.defaultVerify(tampered, pl, pl.after), false);
});

test('migration: the preview names it and the applied file has exactly the three installed events', async t => {
  const d = tmp(t);
  const p = write(d, { hooks: { PreToolUse: [oldOwned()] } });
  const preview = ic.renderPreview(plan(p), { backupPath: p + '.b', apply: false });
  assert.match(preview, /hooks\.PreToolUse: remove/);
  assert.match(preview, /Migration: .*PreToolUse/i);
  const r = io();
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0);
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), ['PermissionRequest', 'SessionStart', 'Stop']);
});

test('planner: remove restores the original JSON (deep equal), also when we created the events', t => {
  const d = tmp(t);
  for (const orig of [{}, { a: 1 }, { hooks: { SessionStart: [{ hooks: [herdr] }] } }, { hooks: { PermissionRequest: [other] } }]) {
    const p = write(d, orig);
    fs.writeFileSync(p, plan(p).after);
    const back = plan(p, { remove: true });
    assert.deepEqual(JSON.parse(back.after), orig);
    assert.equal(ours(JSON.parse(back.after)), false);
  }
  const p = path.join(d, 'nope.json');
  assert.equal(plan(p, { remove: true }).changed, false);
});

test('planner: remove only removes our hook inside a shared matcher group', t => {
  const d = tmp(t);
  const mine = JSON.parse(plan(path.join(d, 'n.json')).after).hooks.Stop[0].hooks[0];
  const orig = { hooks: { Stop: [{ hooks: [herdr, mine] }] } };
  const p = write(d, orig);
  assert.deepEqual(JSON.parse(plan(p, { remove: true }).after), { hooks: { Stop: [{ hooks: [herdr] }] } });
});

test('planner: indentation (tab/2/4) and trailing newline are preserved', t => {
  const d = tmp(t);
  for (const [ind, nl] of [['\t', true], [2, false], [4, true], [2, true]]) {
    const p = write(d, { a: { b: 1 } }, ind, nl);
    const pl = plan(p);
    assert.equal(pl.after, JSON.stringify(JSON.parse(pl.after), null, ind) + (nl ? '\n' : ''));
  }
  const p = path.join(d, 'settings.json'); fs.writeFileSync(p, '{"a":1}');
  assert.equal(plan(p).after.split('\n')[1].startsWith('  "'), true);
});

test('planner: refuses non-strict JSON, non-objects, empty and huge files (65)', t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  for (const text of ['{"a":1,}', '// c\n{}', '{/*c*/}', '[]', 'null', '"x"', '', '{', '\ufeff{}']) {
    fs.writeFileSync(p, text);
    assert.throws(() => plan(p), e => e.exitCode === 65, JSON.stringify(text));
  }
  fs.writeFileSync(p, ' '.repeat(1024 * 1024 + 1) + '{}');
  assert.throws(() => plan(p), e => e.exitCode === 65 && /too large/.test(e.message));
});

test('planner: refuses symlink, non-regular, foreign owner, wrong shapes', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), t => {
  const d = tmp(t);
  const real = write(d, {});
  const link = path.join(d, 'link.json'); fs.symlinkSync(real, link);
  assert.throws(() => plan(link), e => e.exitCode === 65 && /symlink|regular/.test(e.message));
  const dir = path.join(d, 'adir.json'); fs.mkdirSync(dir);
  assert.throws(() => plan(dir), e => e.exitCode === 65);
  assert.throws(() => plan(real, { uid: (process.getuid?.() ?? 0) + 1 }), e => e.exitCode === 65 && /not owned/.test(e.message));
  for (const bad of [{ hooks: [] }, { hooks: null }, { hooks: 'x' }, { hooks: { Stop: {} } }, { hooks: { PermissionRequest: 'x' } }, { hooks: { Stop: null } }]) {
    fs.writeFileSync(real, JSON.stringify(bad));
    assert.throws(() => plan(real), e => e.exitCode === 65 && /unexpected/.test(e.message), JSON.stringify(bad));
  }
});

test('path safety: absolute, normalized, not /proc /sys, dir not world-writable, no symlink parent', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), t => {
  const d = tmp(t);
  for (const bad of ['rel/settings.json', 'settings.json', d + '/../' + path.basename(d) + '/settings.json', d + '//settings.json', '/proc/self/settings.json', '/sys/x/settings.json', d + '/', '']) {
    assert.throws(() => plan(bad), e => e.exitCode === 65 || e.exitCode === 64, bad);
  }
  const wide = path.join(d, 'wide'); fs.mkdirSync(wide); fs.chmodSync(wide, 0o777);
  assert.throws(() => plan(path.join(wide, 's.json')), e => e.exitCode === 65 && /writable/.test(e.message));
  const real = path.join(d, 'real'); fs.mkdirSync(real, { mode: 0o700 });
  const ln = path.join(d, 'ln'); fs.symlinkSync(real, ln);
  assert.throws(() => plan(path.join(ln, 's.json')), e => e.exitCode === 65 && /symlink/.test(e.message));
  assert.throws(() => plan(path.join(d, 'missing', 's.json')), e => e.exitCode === 65);
});

test('--user resolves only from an absolute HOME and a temp HOME in tests', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), t => {
  const d = tmp(t);
  assert.equal(ic.resolveUserSettings({ HOME: d }, () => d), path.join(d, '.claude', 'settings.json'));
  for (const env of [{}, { HOME: '' }, { HOME: 'relative/home' }, { HOME: d + '/../x' }]) assert.throws(() => ic.resolveUserSettings(env, () => d), e => e.exitCode === 64);
  const prev = process.env.HOME; process.env.HOME = d;
  try { assert.equal(ic.resolveUserSettings(process.env, os.homedir), path.join(d, '.claude', 'settings.json')); } finally { process.env.HOME = prev; }
});

test('preview (default): prints plan and diff, never writes, exit 0', async t => {
  const d = tmp(t); write(d, { hooks: { SessionStart: [{ hooks: [herdr] }] } });
  const before = ls(d), bytes = fs.readFileSync(path.join(d, 'settings.json'));
  const r = io({ isTTY: () => false });
  const code = await ic.runInstall(['claude', '--settings', path.join(d, 'settings.json')], r.opts);
  assert.equal(code, 0);
  assert.deepEqual(ls(d), before); assert.deepEqual(fs.readFileSync(path.join(d, 'settings.json')), bytes);
  assert.match(r.out, /dry run: nothing was written/);
  assert.match(r.out, /abito-backup-20260102T030405678Z/);
  assert.match(r.out, /^\+.*PermissionRequest/m);
  assert.match(r.out, /add/); assert.equal(r.err, '');
  assert.deepEqual(r.prompts, []);
});

test('preview diff is bounded to 200 lines', t => {
  const d = tmp(t);
  const p = path.join(d, 'settings.json');
  fs.writeFileSync(p, '{\n  "hooks": ' + JSON.stringify({ X: Array.from({ length: 300 }, (_, i) => ({ hooks: [{ type: 'command', command: '/o' + i }] })) }) + '\n}\n');
  const lines = ic.renderPreview(plan(p), { backupPath: p + '.b', apply: false }).split('\n');
  assert.ok(lines.length < 260); assert.match(lines.join('\n'), /truncated/);
});

test('apply without TTY on stdin or stdout: exit 77, nothing written, no prompt', async t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const before = ls(d), bytes = fs.readFileSync(p);
  const r = io({ isTTY: () => false });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 77);
  assert.deepEqual(ls(d), before); assert.deepEqual(fs.readFileSync(p), bytes); assert.deepEqual(r.prompts, []);
  assert.equal(r.out, '');
});

test('apply: wrong confirmation word aborts with nothing written', async t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const before = ls(d), bytes = fs.readFileSync(p);
  for (const word of ['', 'yes', 'INSTALL', 'install now', 'remove']) {
    const r = io({ prompt: async () => word });
    assert.notEqual(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0);
    assert.deepEqual(ls(d), before); assert.deepEqual(fs.readFileSync(p), bytes);
  }
});

test('apply with the correct word: backup 0600 identical, atomic write, mode kept, no temp leftovers', async t => {
  const d = tmp(t); const orig = { a: 1, hooks: { SessionStart: [{ hooks: [herdr] }] } };
  const p = write(d, orig, 4, true, 0o640); const before = fs.readFileSync(p);
  const r = io();
  const expected = plan(p).after;
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0);
  assert.equal(fs.readFileSync(p, 'utf8'), expected);
  assertMode(p, 0o640);
  const backup = p + '.abito-backup-20260102T030405678Z';
  assert.deepEqual(ls(d), ['settings.json', 'settings.json.abito-backup-20260102T030405678Z']);
  assert.deepEqual(fs.readFileSync(backup), before);
  assertMode(backup, 0o600);
  if (process.platform !== 'win32') assert.match(r.out, new RegExp('cp -p .*' + 'abito-backup-20260102T030405678Z')); // the restore hint is a POSIX cp line
  assert.deepEqual(r.prompts.length, 1);
  // a second install is a no-op without write or backup
  const r2 = io({ now: () => new Date('2026-01-02T03:04:06Z') });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r2.opts), 0);
  assert.equal(ls(d).length, 2);
  // remove needs the word `remove`
  const r3 = io({ now: () => new Date('2026-01-02T03:04:07Z'), prompt: async () => 'install' });
  assert.notEqual(await ic.runInstall(['claude', '--settings', p, '--remove', '--apply'], r3.opts), 0);
  const r4 = io({ now: () => new Date('2026-01-02T03:04:07Z'), prompt: async () => 'remove' });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--remove', '--apply'], r4.opts), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), orig);
});

test('apply to a new file: mode 0600, no backup', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json'); const r = io();
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0);
  assertMode(p, 0o600);
  assert.deepEqual(ls(d), ['settings.json']);
});

test('concurrent modification between preview and apply => exit 70, no write', async t => {
  const d = tmp(t); const p = write(d, { a: 1 });
  const edited = JSON.stringify({ a: 2 });
  const r = io({ prompt: async () => { fs.writeFileSync(p, edited); return 'install'; } });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 70);
  assert.equal(fs.readFileSync(p, 'utf8'), edited); assert.deepEqual(ls(d), ['settings.json']);
  // same size + different content is caught by the hash
  const p2 = write(d, { a: 1 }); const same = JSON.stringify({ a: 2 }, null, 2) + '\n';
  const r2 = io({ prompt: async () => { const st = fs.statSync(p2); fs.writeFileSync(p2, same); fs.utimesSync(p2, st.atime, st.mtime); return 'install'; } });
  assert.equal(await ic.runInstall(['claude', '--settings', p2, '--apply'], r2.opts), 70);
  assert.equal(fs.readFileSync(p2, 'utf8'), same);
  // a file created meanwhile when the target was absent is never clobbered
  fs.rmSync(p2);
  const r3 = io({ prompt: async () => { fs.writeFileSync(p2, '{"mine":1}'); return 'install'; } });
  assert.equal(await ic.runInstall(['claude', '--settings', p2, '--apply'], r3.opts), 70);
  assert.equal(fs.readFileSync(p2, 'utf8'), '{"mine":1}');
  assert.ok(!ls(d).some(n => n.includes('tmp')));
});

test('failing post-write verification restores the backup (exit 70)', async t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const before = fs.readFileSync(p);
  const r = io({ verify: () => false });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 70);
  assert.deepEqual(fs.readFileSync(p), before);
  assert.equal(ls(d).filter(n => n.includes('abito-backup')).length, 1);
  assert.equal(ls(d).length, 2);
  const q = path.join(tmp(t), 'settings.json'); const r2 = io({ verify: () => { throw new Error('boom'); } });
  assert.equal(await ic.runInstall(['claude', '--settings', q, '--apply'], r2.opts), 70);
  assert.equal(fs.existsSync(q), false);
});

test('CLI: usage errors exit 64 with fixed stderr text and empty stdout', t => {
  const d = tmp(t); const p = path.join(d, 's.json');
  const cases = [['install'], ['install', 'claude'], ['install', 'claude', '--bogus'], ['install', 'claude', '--settings'],
    ['install', 'claude', '--settings', p, '--user'], ['install', 'claude', '--settings', 'rel.json'], ['install', 'claude', '--settings', p, '--settings', p],
    ['install', 'claude', '--settings', p, '--timeout-sec', 'x'], ['install', 'claude', '--settings', p, '--remove', '--timeout-sec', '40'], ['install', 'claude', '--settings', p, 'extra']];
  for (const a of cases) {
    const r = spawnSync(EXEC, [BIN, ...a], { env: { PATH: process.env.PATH, HOME: d }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 64, a.join(' ')); assert.equal(r.stdout, ''); assert.match(r.stderr, /^usage: abito-hook install claude/);
  }
  assert.deepEqual(ls(d), []);
});

test('CLI: real binary preview with a temp settings path writes nothing; --apply without TTY exits 77', t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const before = fs.readFileSync(p);
  const env = { PATH: process.env.PATH, HOME: d };
  const a = spawnSync(EXEC, [BIN, 'install', 'claude', '--settings', p], { env, encoding: 'utf8', timeout: 20000, input: '' });
  assert.equal(a.status, 0); assert.match(a.stdout, /dry run: nothing was written/);
  const b = spawnSync(EXEC, [BIN, 'install', 'claude', '--settings', p, '--apply'], { env, encoding: 'utf8', timeout: 20000, input: 'install\n' });
  assert.equal(b.status, 77);
  assert.deepEqual(fs.readFileSync(p), before); assert.deepEqual(ls(d), ['settings.json']);
});

// ---------- U2b fixes: askLine, textual patching ----------
const { PassThrough } = require('node:stream');
async function ask(feed) {
  const input = new PassThrough(), output = new PassThrough();
  const p = ic.askLine(input, output, 'q? ');
  feed(input);
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('askLine hung')), 3000).unref())]);
}
test('askLine resolves once with the first line (the typed word is not lost to close)', async () => {
  assert.equal(await ask(i => i.write('install\n')), 'install');
  assert.equal(await ask(i => i.write('install\nremove\n')), 'install');
  assert.equal(await ask(i => i.write('\n')), '');
  assert.equal(await ask(i => i.end()), '');
  assert.equal(await ask(i => { i.write('  install \n'); }), '  install '); // exact comparison happens in runInstall
});
test('askLine: partial line then EOF follows readline semantics, and apply still needs the exact word', async t => {
  const got = await ask(i => { i.write('inst'); i.end(); });
  assert.ok(got === '' || got === 'inst', 'got ' + JSON.stringify(got));
  const d = tmp(t); const p = write(d, { a: 1 }); const bytes = fs.readFileSync(p);
  for (const feed of [i => { i.write('inst'); i.end(); }, i => i.end(), i => i.write('Install\n')]) {
    const r = io({ prompt: q => ask(feed) });
    assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 1);
    assert.deepEqual(fs.readFileSync(p), bytes);
  }
  const r = io({ prompt: q => ask(i => i.write('install\n')) });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0);
});

function outside(pl) {
  const pa = pl.patch;
  assert.ok(pa, 'patch present');
  assert.equal(pl.after, pl.baseText.slice(0, pa.start) + pa.text + pl.baseText.slice(pa.end));
  return [pl.baseText.slice(0, pa.start), pl.baseText.slice(pa.end)];
}
function raw(t, text, name = 'settings.json') { const d = tmp(t); const p = path.join(d, name); fs.writeFileSync(p, text, { mode: 0o600 }); return p; }

test('textual patch: numbers, duplicate keys, __proto__, unicode escapes and key order stay byte-identical', t => {
  const src = '{\n  "big": 12345678901234567890,\n  "b2": 9007199254740993,\n  "inf": 1e400,\n  "ninf": -1e400,\n  "dup": 1,\n  "dup": 2,\n  "__proto__": {"x": 1},\n  "constructor": {"prototype": 1},\n  "e": "caf\\u00e9",\n  "z": 1,\n  "a": 2\n}\n';
  const p = raw(t, src);
  const pl = plan(p);
  const [pre, suf] = outside(pl);
  assert.equal(pre + suf.slice(0), pre + suf);
  assert.ok(pl.after.startsWith(src.slice(0, src.lastIndexOf('\n  "a": 2') + '\n  "a": 2'.length)));
  for (const tok of ['12345678901234567890', '9007199254740993', '1e400', '-1e400', '"dup": 1,\n  "dup": 2', '"__proto__": {"x": 1}', 'caf\\u00e9']) assert.ok(pl.after.includes(tok), tok);
  assert.ok(pl.after.endsWith('\n  }\n}\n'));
  assert.equal(pl.after.replace(pl.patch.text, ''), src.slice(0, pl.patch.start) + src.slice(pl.patch.end));
  // round trip back
  fs.writeFileSync(p, pl.after);
  assert.equal(plan(p, { remove: true }).after, src);
});

test('textual patch: CRLF preserved in inserted text, tab and 4-space indentation', t => {
  const crlf = '{\r\n  "a": 1\r\n}\r\n';
  const a = plan(raw(t, crlf)).after;
  assert.equal(a.replace(/\r\n/g, ''), a.replace(/\r\n/g, '').replace(/\n/g, ''), 'no bare LF');
  assert.ok(a.startsWith('{\r\n  "a": 1,\r\n  "hooks": {\r\n    "PermissionRequest"'));
  assert.ok(a.endsWith('  }\r\n}\r\n'));
  const tab = plan(raw(t, '{\n\t"a": 1\n}\n')).after;
  assert.ok(tab.includes('\n\t"hooks": {\n\t\t"PermissionRequest": [\n\t\t\t{'));
  const four = plan(raw(t, '{\n    "a": 1\n}')).after;
  assert.ok(four.includes('\n    "hooks": {\n        "PermissionRequest"'));
  assert.ok(four.endsWith('    }\n}'));
});

test('textual patch: oddly spaced JSON, {}, no trailing newline, existing nested hooks', t => {
  let pl = plan(raw(t, '{"a" :1,"hooks":{}}'));
  let [pre, suf] = outside(pl);
  assert.equal(pre, '{"a" :1,"hooks":'); assert.equal(suf, '}');
  assert.equal(JSON.parse(pl.after).a, 1);
  pl = plan(raw(t, '{}'));
  assert.equal(pl.after.replace(/\s/g, '').slice(0, 9), '{"hooks":'); assert.ok(pl.after.startsWith('{\n  "hooks": {')); assert.ok(pl.after.endsWith('\n}'));
  const orig = '{"x":1.50,\n "hooks": {"SessionStart":[{"hooks":[{"type":"command","command":"/h","timeout":1.5}]}]},\n "y":[1,2]}';
  pl = plan(raw(t, orig));
  [pre, suf] = outside(pl);
  assert.equal(pre, '{"x":1.50,\n "hooks": '); assert.equal(suf, ',\n "y":[1,2]}');
  const o = JSON.parse(pl.after);
  assert.equal(o.hooks.SessionStart[0].hooks[0].timeout, 1.5); assert.equal(o.hooks.Stop.length, 1);
  assert.ok(pl.after.includes('\n '));
});

test('textual patch: remove deletes the hooks member and its comma when it becomes empty', t => {
  const mk = text => { const p = raw(t, text); fs.writeFileSync(p, plan(p).after); return plan(p, { remove: true }).after; };
  assert.deepEqual(JSON.parse(mk('{"a":1}')), { a: 1 }); // one-line files gain a newline before the closing brace (documented)
  for (const text of ['{\n  "a": 1\n}\n', '{}', '{\n  "a": 1,\n  "b": 2\n}']) assert.equal(mk(text), text);
  // hooks first / middle member
  const first = '{\n  "hooks": {"Stop": []},\n  "a": 1\n}\n';
  const p = raw(t, first);
  assert.deepEqual(JSON.parse(plan(p).after).a, 1);
  const mid = '{"a":1,"hooks":{"Stop":[{"hooks":[]}]},"b":2}';
  const pm = raw(t, mid);
  const installed = plan(pm).after; fs.writeFileSync(pm, installed);
  const rm = plan(pm, { remove: true });
  assert.deepEqual(JSON.parse(rm.after), { a: 1, hooks: { Stop: [{ hooks: [] }] }, b: 2 });
  // sole member: {"hooks":{}} -> {} after install+remove (R1)
  const q = raw(t, '{"hooks":{}}'); fs.writeFileSync(q, plan(q).after);
  assert.equal(plan(q, { remove: true }).after, '{}');
  // member removed, comma handled for first/middle/last positions
  const ins = '{"a":1,"hooks":{"PermissionRequest":[{"hooks":[]}]},"c":3}';
  const p3 = raw(t, ins); const w = plan(p3);
  assert.ok(JSON.parse(w.after).hooks.Stop);
});

test('textual patch refuses (65): top-level not object, invalid JSON, duplicate hooks, lossy numbers or duplicate keys inside hooks', t => {
  const bad = ['[]', 'null', '1', '{"a":1,}', '{"a" 1}', '{"a":01}', '{"a":1e}', "{'a':1}", '{"a":"\\x"}', '{"a":"\t"}', '{"a":1} x', '{"hooks":{},"hooks":{}}', '{"hooks":{},"hook\\u0073":{}}',
    '{"hooks":{"S":[{"n":1e400}]}}', '{"hooks":{"S":[{"n":12345678901234567890}]}}', '{"hooks":{"S":[{"n":9007199254740993}]}}', '{"hooks":{"S":[{"n":0.1234567890123456789}]}}', '{"hooks":{"S":[{"n":-0}]}}', '{"hooks":{"S":[{"n":1e-400}]}}',
    '{"hooks":{"S":[{"k":1,"k":2}]}}', '{"hooks":{"S":{"hooks":[]}, "S":1}}'];
  for (const text of bad) assert.throws(() => plan(raw(t, text)), e => e.exitCode === 65, text);
  const good = '{"hooks":{"S":[{"n":1.0,"m":0.1,"k":1e2,"s":9007199254740991,"z":-1.5E+2}]}}';
  assert.doesNotThrow(() => plan(raw(t, good)));
  assert.throws(() => plan(raw(t, '{"hooks":{"S":[{"n":1e400}]}}')), e => /number|hooks/.test(e.message));
});

test('preview: diff cap reports hidden lines and always lists changed lines outside hooks (0)', t => {
  const d = tmp(t);
  const hooks = { X: Array.from({ length: 300 }, (_, i) => ({ hooks: [{ type: 'command', command: '/o' + i }] })) };
  const p = path.join(d, 'settings.json'); fs.writeFileSync(p, '{\n  "a": 1,\n  "hooks": ' + JSON.stringify(hooks) + '\n}\n');
  const out = ic.renderPreview(plan(p), { backupPath: p + '.b', apply: false });
  assert.match(out, /\.\.\. diff truncated: \d+ more lines hidden/);
  assert.match(out, /^Lines changed outside hooks: 0$/m);
  const small = ic.renderPreview(plan(raw(t, '{"a":1}')), { backupPath: 'x', apply: false });
  assert.match(small, /^Lines changed outside hooks: 0$/m);
});

test('preview wording: settings directory must exist and is never created; --user refuses with 65', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  const d = tmp(t);
  const out = ic.renderPreview(plan(path.join(d, 'settings.json')), { backupPath: 'x', apply: false });
  assert.match(out, /directory: must already exist/);
  assert.doesNotMatch(out, /directory.*would be created|would be created.*director/i);
  const r = io({ env: { HOME: d }, homedir: () => d });
  assert.equal(await ic.runInstall(['claude', '--user', '--apply'], r.opts), 65);
  assert.deepEqual(ls(d), []);
  assert.match(r.err, /settings directory does not exist/);
});

test('apply: failed verification + failed restore does not claim success (exit 70, backup path named)', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  if (process.getuid?.() === 0) return;
  const d = tmp(t); const p = write(d, { a: 1 });
  const r = io({ verify: () => { fs.chmodSync(d, 0o500); return false; } });
  try {
    assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 70);
  } finally { fs.chmodSync(d, 0o700); }
  assert.match(r.err, /could not restore automatically; your original is at .*abito-backup-/);
  assert.doesNotMatch(r.err, /were restored/);
  assert.ok(ls(d).some(n => n.includes('abito-backup')));
});

test('verify also checks bytes outside the patch', async t => {
  const d = tmp(t); const p = write(d, { a: 1 });
  const pl = plan(p);
  const good = fs.readFileSync(p, 'utf8');
  assert.equal(ic.defaultVerify(JSON.parse(pl.after), pl, pl.after), true);
  const tampered = pl.after.replace('"a": 1', '"a": 2');
  assert.equal(ic.defaultVerify(JSON.parse(tampered), pl, tampered), false);
  assert.equal(good.length > 0, true);
});

// ---------- re-verification: byte-exact UTF-8 and prompt timeout ----------
function rawBytes(t, buf) { const d = tmp(t); const p = path.join(d, 'settings.json'); fs.writeFileSync(p, buf, { mode: 0o600 }); return p; }
test('non-UTF-8 settings bytes are refused (exit 65), never rewritten as U+FFFD', async t => {
  const cases = {
    latin1: Buffer.concat([Buffer.from('{"n":"caf'), Buffer.from([0xe9]), Buffer.from('","a":1}\n')]),
    overlong: Buffer.concat([Buffer.from('{"n":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('","a":1}\n')]),
    continuation: Buffer.concat([Buffer.from('{"n":"'), Buffer.from([0x80]), Buffer.from('","a":1}\n')]),
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]),
  };
  for (const [name, buf] of Object.entries(cases)) {
    const p = rawBytes(t, buf);
    assert.throws(() => plan(p), e => e.exitCode === 65, name);
    const r = io();
    assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 65, name);
    assert.deepEqual(fs.readFileSync(p), buf, name);
    assert.deepEqual(ls(path.dirname(p)), ['settings.json'], name);
  }
});
test('valid multi-byte UTF-8 is accepted and preserved byte-exact outside hooks', async t => {
  const src = Buffer.from('{\n  "n": "café 😀",\n  "a": 1\n}\n', 'utf8');
  const p = rawBytes(t, src);
  const r = io();
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 0, r.err);
  const after = fs.readFileSync(p);
  const pre = src.subarray(0, src.length - 3);
  assert.ok(after.subarray(0, pre.length).equals(pre));
  assert.ok(after.subarray(after.length - 3).equals(src.subarray(src.length - 3)));
});
test('apply refuses when the bytes around the patched span differ from the original bytes', async t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const bytes = fs.readFileSync(p);
  const pl = plan(p);
  pl.after = pl.after.replace('"a"', '"b"');
  const r = io();
  const code = await ic.applyPlan(pl, { backupPath: ic.backupPathFor(p, new Date(0)), out: s => { r.out += s; }, err: s => { r.err += s; } });
  assert.equal(code, 70);
  assert.deepEqual(fs.readFileSync(p), bytes);
  assert.deepEqual(ls(d), ['settings.json']);
});
test('askLine times out (injected 50 ms) when a line never arrives, and also resolves on input end/error', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const t0 = Date.now();
  const got = await Promise.race([ic.askLine(input, output, 'q? ', 50), new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000).unref())]);
  assert.equal(got, ''); assert.ok(Date.now() - t0 < 2000);
  const i2 = new PassThrough(); const p2 = ic.askLine(i2, new PassThrough(), 'q? ', 60000); i2.write('inst'); i2.emit('error', new Error('x'));
  assert.equal(await Promise.race([p2, new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000).unref())]), '');
});
test('runInstall: a timed-out prompt aborts with exit 1, message, nothing written', async t => {
  const d = tmp(t); const p = write(d, { a: 1 }); const bytes = fs.readFileSync(p);
  const st = {};
  const r = io({ prompt: q => ic.askLine(new PassThrough(), new PassThrough(), q, 50, st), timedOut: () => st.timedOut });
  assert.equal(await ic.runInstall(['claude', '--settings', p, '--apply'], r.opts), 1);
  assert.match(r.err, /confirmation timed out/);
  assert.deepEqual(fs.readFileSync(p), bytes); assert.deepEqual(ls(d), ['settings.json']);
});
test('install CLI clamps ABITO_INSTALL_PROMPT_TIMEOUT_MS to 100..600000', () => {
  assert.equal(ic.promptTimeoutFromEnv({}), 120000);
  assert.equal(ic.promptTimeoutFromEnv({ ABITO_INSTALL_PROMPT_TIMEOUT_MS: '1' }), 100);
  assert.equal(ic.promptTimeoutFromEnv({ ABITO_INSTALL_PROMPT_TIMEOUT_MS: '99999999' }), 600000);
  assert.equal(ic.promptTimeoutFromEnv({ ABITO_INSTALL_PROMPT_TIMEOUT_MS: 'abc' }), 120000);
  assert.equal(ic.promptTimeoutFromEnv({ ABITO_INSTALL_PROMPT_TIMEOUT_MS: '500' }), 500);
});

// ---- HU-068: hooks Abito wrote from a FORMER location (AppTranslocation, Downloads, an old install dir) ----
test('HU-068: remove deletes Abito hooks pointing at any former location, never a foreign hook', t => {
  const d = tmp(t);
  const former = [
    '/private/var/folders/zz/T/AppTranslocation/0B1C2D3E-0000-4000-8000-000000000001/d/Abito.app/Contents/Resources/desktop-harness/bin/abito-hook.cjs',
    '/Users/amigo/Downloads/Abito.app/Contents/Resources/desktop-harness/bin/abito-hook.cjs',
    'C:\\Users\\amigo\\AppData\\Local\\Abito-old\\resources\\desktop-harness\\bin\\abito-hook.cjs',
  ];
  const entry = (bin, sub = 'stop') => ({ type: 'command', command: '/usr/local/bin/node', args: [bin, 'claude', sub], timeout: 15 });
  const foreign = [
    herdr,
    { type: 'command', command: '/usr/local/bin/node', args: ['/opt/tool/abito-hook.cjs.bak', 'claude', 'stop'] },   // look-alike name
    { type: 'command', command: '/usr/local/bin/node', args: ['/opt/tool/abito-hook.cjs', 'other', 'stop'] },         // not the claude subcommand
    { type: 'command', command: '/opt/abito-hook.cjs' },                                                              // no args
  ];
  const orig = { hooks: {
    Stop: [{ hooks: [...former.map(b => entry(b)), foreign[0], foreign[1]] }],
    SessionStart: [{ hooks: [entry(former[0], 'session-start'), foreign[2]] }],
    PermissionRequest: [{ hooks: [entry(former[1], 'permission-request'), foreign[3]] }],
  } };
  const p = write(d, orig);
  const back = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(back.after), { hooks: {
    Stop: [{ hooks: [foreign[0], foreign[1]] }], SessionStart: [{ hooks: [foreign[2]] }], PermissionRequest: [{ hooks: [foreign[3]] }],
  } });
});

test('HU-068: install replaces a former-location hook with the current one instead of leaving two', t => {
  const d = tmp(t);
  const old = '/private/var/folders/zz/T/AppTranslocation/X/d/Abito.app/Contents/Resources/desktop-harness/bin/abito-hook.cjs';
  const p = write(d, { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/node', args: [old, 'claude', 'stop'], timeout: 15 }, herdr] }] } });
  const after = JSON.parse(plan(p).after).hooks.Stop[0].hooks;
  assert.equal(JSON.stringify(after).includes('AppTranslocation'), false);
  assert.deepEqual(after.map(h => h.command), [EXEC, herdr.command]);
  assert.equal(after[0].args[0], BIN);
});

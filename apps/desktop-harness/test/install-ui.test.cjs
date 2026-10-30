'use strict';
const { tmpBase, assertMode, unixOnly } = require('./platform-env.cjs');
// Unit tests for src/install-ui.cjs (plan hash, preview JSON, guards, audit log). Temp dirs only; the real ~/.claude and ~/.codex are never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('../src/install-ui.cjs');

const BIN = path.resolve(__dirname, '../bin/abito-hook.cjs');
const hex64 = /^[0-9a-f]{64}$/;
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-instui-')));
  fs.chmodSync(d, 0o700);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const ls = d => fs.readdirSync(d).sort();
async function run(argv, extra = {}) {
  const lines = [];
  const code = await ui.runInstallUi(argv, { out: s => lines.push(s), env: {}, ...extra });
  return { code, lines, json: lines.length === 1 ? JSON.parse(lines[0]) : null };
}
const preview = async (harness, p, more = []) => (await run([harness, '--settings', p, '--json', ...more])).json;

test('INSTALLER_VERSION is a non-empty constant string', () => {
  assert.equal(typeof ui.INSTALLER_VERSION, 'string');
  assert.ok(ui.INSTALLER_VERSION.length > 0);
});

test('plan_hash is deterministic and 64 lowercase hex', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  fs.writeFileSync(p, '{\n  "a": 1\n}\n');
  const a = await preview('claude', p), b = await preview('claude', p);
  assert.match(a.plan_hash, hex64);
  assert.equal(a.plan_hash, b.plan_hash);
  const fixed = { now: () => new Date('2026-01-02T03:04:05.678Z') };
  assert.deepEqual((await run(['claude', '--settings', p, '--json'], fixed)).json, (await run(['claude', '--settings', p, '--json'], fixed)).json);
});

test('plan_hash changes with content, timeout, action, harness and path', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json'); const q = path.join(d, 'other.json');
  fs.writeFileSync(p, '{"a":1}\n'); fs.writeFileSync(q, '{"a":1}\n');
  const base = (await preview('claude', p)).plan_hash;
  const seen = new Set([base]);
  const add = h => { assert.match(h, hex64); assert.ok(!seen.has(h), 'hash collided: ' + h); seen.add(h); };
  add((await preview('claude', p, ['--timeout-sec', '40'])).plan_hash);
  add((await preview('codex', p)).plan_hash);
  add((await preview('claude', q)).plan_hash);
  fs.writeFileSync(p, '{"a":2}\n');
  add((await preview('claude', p)).plan_hash);
  // action: an installed file previewed as install (no-op) vs remove
  fs.writeFileSync(p, '{"a":1}\n');
  add((await preview('claude', p, ['--remove'])).plan_hash);
});

test('plan_hash binds execPath, binPath and installerVersion', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  fs.writeFileSync(p, '{}\n');
  const base = (await run(['claude', '--settings', p, '--json'])).json.plan_hash;
  const other = (await run(['claude', '--settings', p, '--json'], { execPath: '/usr/bin/true' })).json.plan_hash;
  const otherBin = (await run(['claude', '--settings', p, '--json'], { binPath: '/opt/x/abito-hook.cjs' })).json.plan_hash;
  assert.notEqual(base, other); assert.notEqual(base, otherBin); assert.notEqual(other, otherBin);
  const core = require('../src/install-claude.cjs');
  const plan = core.planClaudeSettings({ settingsPath: p });
  assert.notEqual(ui.computePlanHash(plan, 'claude', 'install', 'v1'), ui.computePlanHash(plan, 'claude', 'install', 'v2'));
});

function checkPreview(j, harness, p) {
  assert.deepEqual(Object.keys(j).sort(), ['action', 'backup_path', 'changed', 'diff', 'entries', 'exists', 'harness', 'mode', 'notes', 'ok', 'plan_hash', 'requires_trust_review', 'schema', 'target'].sort());
  assert.equal(j.schema, 'abito-hook-install/1'); assert.equal(j.ok, true); assert.equal(j.mode, 'preview');
  assert.equal(j.harness, harness); assert.equal(j.target, p);
  assert.ok(['install', 'remove'].includes(j.action));
  assert.equal(typeof j.exists, 'boolean'); assert.equal(typeof j.changed, 'boolean');
  // S2: Claude installs three events; PreToolUse is only ever REMOVED (migration), never installed.
  // S4/T2: the Codex row is notice-only — permission requests, plan-mode questions and the mid-turn clearing entry.
  assert.deepEqual(j.entries.map(e => e.event), harness === 'claude' ? ['PermissionRequest', 'SessionStart', 'Stop']
    : ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']);
  for (const e of j.entries) { assert.deepEqual(Object.keys(e).sort(), ['event', 'op']); assert.ok(['add', 'replace', 'remove', 'keep'].includes(e.op)); }
  assert.ok(j.backup_path === null || (path.isAbsolute(j.backup_path) && j.backup_path.startsWith(p + '.abito-backup-')));
  assert.deepEqual(Object.keys(j.diff).sort(), ['hidden', 'lines', 'outside_hooks_changed_lines']);
  assert.ok(Array.isArray(j.diff.lines) && j.diff.lines.length <= 200);
  for (const l of j.diff.lines) { assert.equal(typeof l, 'string'); assert.ok(l.length <= 300); assert.ok(!CTRL.test(l)); }
  assert.ok(Number.isInteger(j.diff.hidden) && j.diff.hidden >= 0);
  assert.equal(j.diff.outside_hooks_changed_lines, 0);
  assert.equal(j.requires_trust_review, harness === 'codex' && j.action === 'install');
  assert.match(j.plan_hash, hex64);
  assert.ok(Array.isArray(j.notes) && j.notes.every(n => typeof n === 'string'));
}

test('preview JSON schema: claude and codex, new file and existing file, remove', async t => {
  const d = tmp(t);
  for (const h of ['claude', 'codex']) {
    const p = path.join(d, h + '.json');
    let j = await preview(h, p); checkPreview(j, h, p);
    assert.equal(j.exists, false); assert.equal(j.changed, true); assert.equal(j.backup_path, null);
    assert.ok(j.entries.length >= 2 && j.entries.every(e => e.op === 'add'));
    fs.writeFileSync(p, '{\n  "keep": true\n}\n');
    j = await preview(h, p); checkPreview(j, h, p);
    assert.equal(j.exists, true); assert.ok(j.backup_path); assert.ok(j.diff.lines.some(l => l.startsWith('+')));
    j = await preview(h, p, ['--remove']); checkPreview(j, h, p);
    assert.equal(j.action, 'remove'); assert.equal(j.changed, false); assert.ok(j.entries.length >= 2 && j.entries.every(e => e.op === 'keep'));
    assert.deepEqual(j.diff.lines, []); assert.equal(j.backup_path, null);
  }
});

test('preview diff is bounded to 200 lines, sanitized and truncated per line', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  const groups = [];
  for (let i = 0; i < 150; i++) groups.push({ hooks: [{ type: 'command', command: i === 0 ? 'x\u2028y\u0085z' + 'L'.repeat(1000) : 'cmd' + i }] });
  fs.writeFileSync(p, '{"hooks":{"Stop":' + JSON.stringify(groups) + '}}\n'); // one compact line: re-serializing explodes the diff
  const j = await preview('claude', p);
  checkPreview(j, 'claude', p);
  assert.equal(j.diff.lines.length, 200);
  assert.ok(j.diff.hidden > 0);
  assert.ok(j.diff.lines.some(l => l.length === 300), 'long line cut at 300');
});

test('preview writes nothing', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  fs.writeFileSync(p, '{"a":1}\n');
  const before = ls(d), bytes = fs.readFileSync(p), st = fs.statSync(p);
  await preview('claude', p); await preview('codex', p, ['--remove']);
  assert.deepEqual(ls(d), before);
  assert.ok(fs.readFileSync(p).equals(bytes)); assert.equal(fs.statSync(p).mtimeMs, st.mtimeMs);
});

test('refusals are one fixed JSON line with the right exit code and never echo the file', async t => {
  const d = tmp(t);
  const bad = path.join(d, 'bad.json'); fs.writeFileSync(bad, Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x7d]));
  let r = await run(['claude', '--settings', bad, '--json']);
  assert.equal(r.code, 65); assert.deepEqual(Object.keys(r.json).sort(), ['code', 'message', 'ok', 'schema']); assert.equal(r.json.ok, false);
  assert.equal(r.json.schema, 'abito-hook-install/1'); assert.ok(!r.lines[0].includes(d));
  const notjson = path.join(d, 'nj.json'); fs.writeFileSync(notjson, 'SECRET-CONTENT');
  r = await run(['claude', '--settings', notjson, '--json']);
  assert.equal(r.code, 65); assert.ok(!r.lines[0].includes('SECRET'));
  for (const argv of [['claude', '--json'], ['nope', '--user', '--json'], ['claude', '--settings', bad, '--json', '--apply'], ['claude', '--settings', bad, '--json', '--timeout-sec', 'x']]) {
    r = await run(argv); assert.equal(r.code, 64, argv.join(' ')); assert.equal(r.json.ok, false); assert.equal(r.json.code, 'usage');
  }
});

test('island guard: needs ABITO_ISLAND_EXE equal to the parent executable', () => {
  const exe = fs.realpathSync(process.execPath);
  const ok = ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe }, 42, () => exe);
  assert.equal(ok, true);
  assert.equal(ui.checkIslandGuards({}, 42, () => exe), false);
  // HU-047: Windows paths are case-insensitive; the same executable spelled with another case is the same parent.
  const w = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: w }, 42, () => w.toLowerCase(), 'win32', p => p), true);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: w }, 42, () => 'C:\\Other\\pwsh.exe', 'win32', p => p), false);
  if (process.platform === 'win32') { // the product compares case-insensitively here (asserted above with the injected win32 platform); the rest is POSIX path syntax
    assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe }, 42, () => exe.toUpperCase()), true, 'Windows comparison is case-insensitive by default');
    return;
  }
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe }, 42, () => exe.toUpperCase()), false, 'Linux comparison stays case-sensitive');
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: 'relative/node' }, 42, () => exe), false);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: '/bin/sh' }, 42, () => exe), false);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe }, 42, () => { throw new Error('no /proc'); }), false);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: '/does/not/exist' }, 42, () => exe), false);
});

test('island guard: every agent marker refuses; empty marker does not', () => {
  const exe = fs.realpathSync(process.execPath);
  const names = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'OPENCODE', 'OPENCODE_X', 'AI_AGENT', 'GENTLE_PI_SESSION'];
  for (const n of names) assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe, [n]: '1' }, 1, () => exe), false, n);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: exe, CLAUDECODE: '' }, 1, () => exe), true);
});

test('audit log: creates dir 0700 and file 0600, appends lines, refuses unsafe dirs', t => {
  const d = tmp(t);
  const dir = path.join(d, 'audit');
  ui.appendAudit(dir, { ts: 1, event: 'intent' });
  ui.appendAudit(dir, { ts: 2, event: 'result' });
  assertMode(dir, 0o700);
  const f = path.join(dir, 'hook-installs.jsonl');
  assertMode(f, 0o600);
  assert.deepEqual(fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l).ts), [1, 2]);
  if (process.platform === 'win32') return; // unsafe-dir refusals (symlink, world-writable) are the helper's DACL/reparse checks: win-install-fake.test.cjs
  const link = path.join(d, 'link'); fs.symlinkSync(dir, link);
  assert.throws(() => ui.appendAudit(link, {}));
  const ww = path.join(d, 'ww'); fs.mkdirSync(ww, { mode: 0o700 }); fs.chmodSync(ww, 0o777);
  assert.throws(() => ui.appendAudit(ww, {}));
  assert.throws(() => ui.appendAudit('/usr', {}));
  assert.throws(() => ui.appendAudit('relative/dir', {}));
  assert.throws(() => ui.appendAudit(path.join(d, 'no', 'parent'), {}));
  assert.throws(() => ui.appendAudit(dir + '/', {}));
  const d2 = path.join(d, 'a2'); fs.mkdirSync(d2, { mode: 0o700 });
  fs.symlinkSync(path.join(d, 'elsewhere'), path.join(d2, 'hook-installs.jsonl'));
  assert.throws(() => ui.appendAudit(d2, {}));
  const d3 = path.join(d, 'a3'); fs.mkdirSync(d3, { mode: 0o700 });
  fs.writeFileSync(path.join(d3, 'hook-installs.jsonl'), '', { mode: 0o644 }); fs.chmodSync(path.join(d3, 'hook-installs.jsonl'), 0o644);
  assert.throws(() => ui.appendAudit(d3, {}));
});

// ---- hardening round: case-insensitive markers, backup collisions, lock, refusal audit, rotation ----
const EXE = fs.realpathSync(process.execPath);
const applyOpts = (extra = {}) => ({ env: { ABITO_ISLAND_EXE: EXE }, ppid: 1, readExe: () => EXE, ...extra });
const applyVia = (harness, p, audit, hash, extra = {}, more = []) => run([harness, '--settings', p, ...more, '--apply-plan', hash, '--audit-dir', audit, '--json'], applyOpts(extra));
const auditLines = audit => fs.readFileSync(path.join(audit, 'hook-installs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function world(t, content = '{"keep":true}\n') {
  const d = tmp(t); const p = path.join(d, 'settings.json'); if (content !== null) fs.writeFileSync(p, content);
  const audit = path.join(d, 'audit'); fs.mkdirSync(audit, { mode: 0o700 });
  return { d, p, audit };
}

test('island guard: agent markers are matched case-insensitively', () => {
  for (const n of ['claudecode', 'Claude_Code_Entrypoint', 'opencode', 'OpenCode_Foo', 'opencode_x', 'ai_agent', 'Pi_Session_Id'])
    assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: EXE, [n]: '1' }, 1, () => EXE), false, n);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: EXE, claudecode: '' }, 1, () => EXE), true);
  assert.equal(ui.checkIslandGuards({ ABITO_ISLAND_EXE: EXE, claudecode: undefined, opencode_x: '' }, 1, () => EXE), true);
});

test('backup name collision: same-millisecond backup gets a -1..-9 suffix, 0600, no apply_failed', async t => {
  const w = world(t); const core = require('../src/install-claude.cjs');
  const now = () => new Date('2026-01-02T03:04:05.678Z');
  const base = core.backupPathFor(w.p, now());
  fs.writeFileSync(base, 'squatter');
  fs.symlinkSync(path.join(w.d, 'nowhere'), base + '-1'); // dangling symlink also counts as taken
  const hash = (await preview('claude', w.p)).plan_hash;
  const r = await applyVia('claude', w.p, w.audit, hash, { now });
  assert.equal(r.code, 0, r.lines[0]); assert.equal(r.json.backup, base + '-2');
  assertMode(r.json.backup, 0o600);
  assert.equal(fs.readFileSync(base, 'utf8'), 'squatter'); assert.equal(fs.existsSync(path.join(w.d, 'nowhere')), false);
  assert.equal(auditLines(w.audit)[1].backup, base + '-2');
});

test('backup name collision is bounded: all of base, -1..-9 taken => apply_failed, settings untouched', async t => {
  const w = world(t); const core = require('../src/install-claude.cjs');
  const now = () => new Date('2026-01-02T03:04:05.678Z'); const base = core.backupPathFor(w.p, now());
  fs.writeFileSync(base, 'x'); for (let i = 1; i <= 9; i++) fs.writeFileSync(base + '-' + i, 'x');
  const hash = (await preview('claude', w.p)).plan_hash;
  const r = await applyVia('claude', w.p, w.audit, hash, { now });
  assert.equal(r.code, 70); assert.equal(r.json.code, 'apply_failed'); assert.equal(fs.readFileSync(w.p, 'utf8'), '{"keep":true}\n');
});

test('TTY backupPathFor keeps the historical name', () => {
  const core = require('../src/install-claude.cjs');
  assert.equal(core.backupPathFor('/a/s.json', new Date('2026-01-02T03:04:05.678Z')), '/a/s.json.abito-backup-20260102T030405678Z');
});

const aged = (p, secs = 60) => { const when = (Date.now() - secs * 1000) / 1000; fs.lutimesSync(p, when, when); };
const lockPath = p => path.join(path.dirname(p), '.' + path.basename(p) + '.abito-lock');

test('lock: planted regular file older than 30 s is unlinked and the lock taken', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  const w = world(t); fs.writeFileSync(lockPath(w.p), 'junk'); aged(lockPath(w.p));
  const hash = (await preview('claude', w.p)).plan_hash;
  const r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 300 });
  assert.equal(r.code, 0, r.lines[0]); assert.equal(fs.existsSync(lockPath(w.p)), false);
});
test('lock: planted symlink older than 30 s is unlinked, never followed', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  const w = world(t); const victim = path.join(w.d, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep'), 'k');
  fs.symlinkSync(victim, lockPath(w.p)); aged(lockPath(w.p));
  const hash = (await preview('claude', w.p)).plan_hash;
  const r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 300 });
  assert.equal(r.code, 0, r.lines[0]); assert.equal(fs.existsSync(lockPath(w.p)), false);
  assert.equal(fs.readFileSync(path.join(victim, 'keep'), 'utf8'), 'k');
});
test('lock: planted young file or symlink => busy, nothing written', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  for (const kind of ['file', 'symlink']) {
    const w = world(t);
    if (kind === 'file') fs.writeFileSync(lockPath(w.p), 'junk'); else fs.symlinkSync(path.join(w.d, 'nowhere'), lockPath(w.p));
    const hash = (await preview('claude', w.p)).plan_hash;
    const r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 200 });
    assert.equal(r.code, 70, kind); assert.equal(r.json.code, 'busy'); assert.equal(fs.readFileSync(w.p, 'utf8'), '{"keep":true}\n');
    assert.ok(fs.lstatSync(lockPath(w.p)));
  }
});
test('lock: stale directory (with owner token) is reclaimed; young directory => busy', async t => {
  const w = world(t); fs.mkdirSync(lockPath(w.p)); fs.writeFileSync(path.join(lockPath(w.p), 'owner'), 'old');
  const hash = (await preview('claude', w.p)).plan_hash;
  let r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 200 });
  assert.equal(r.json.code, 'busy');
  aged(lockPath(w.p));
  r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 200 });
  assert.equal(r.code, 0, r.lines[0]); assert.equal(fs.existsSync(lockPath(w.p)), false);
});
test('lock: releaseLock removes the lock only while the owner token still matches', t => {
  const d = tmp(t); const target = path.join(d, 's.json');
  const a = ui.acquireLock(target, 100);
  assert.ok(a); assert.equal(fs.statSync(a.dir).isDirectory(), true);
  fs.writeFileSync(path.join(a.dir, 'owner'), 'someone-else'); // stolen / replaced
  ui.releaseLock(a);
  assert.equal(fs.existsSync(a.dir), true, 'stolen lock must survive the old holder');
  fs.rmSync(a.dir, { recursive: true });
  const b = ui.acquireLock(target, 100); assert.ok(b); ui.releaseLock(b); assert.equal(fs.existsSync(b.dir), false);
});
test('lock: unwritable settings directory => not_writable (65), not busy', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  if (process.getuid?.() === 0) return t.skip('root ignores permission bits');
  const w = world(t); const hash = (await preview('claude', w.p)).plan_hash;
  fs.chmodSync(w.d, 0o500);
  let r; try { r = await applyVia('claude', w.p, w.audit, hash, { lockWaitMs: 200 }); } finally { fs.chmodSync(w.d, 0o700); }
  assert.equal(r.code, 65, r.lines[0]); assert.equal(r.json.code, 'not_writable');
});

test('refusals after argument validation append a refused audit line; exit codes unchanged', async t => {
  const w = world(t); const good = (await preview('claude', w.p)).plan_hash; const bogus = 'a'.repeat(64);
  let r = await applyVia('claude', w.p, w.audit, bogus);
  assert.equal(r.code, 70); assert.equal(r.json.code, 'plan_changed');
  r = await applyVia('claude', w.p, w.audit, good, { env: {} });
  assert.equal(r.code, 77); assert.equal(r.json.code, 'not_island');
  const l = auditLines(w.audit);
  assert.equal(l.length, 2);
  assert.deepEqual(Object.keys(l[0]).sort(), ['code', 'event', 'plan_hash', 'ts']);
  assert.deepEqual([l[0].event, l[0].code, l[0].plan_hash], ['refused', 'plan_changed', bogus]);
  assert.deepEqual([l[1].event, l[1].code, l[1].plan_hash], ['refused', 'not_island', good]);
  assert.ok(Number.isInteger(l[0].ts));
  r = await applyVia('claude', w.p, w.audit, good, { lockWaitMs: 100, env: { ABITO_ISLAND_EXE: EXE } });
  assert.equal(r.code, 0);
});
test('refused audit line is never written for usage errors or an invalid audit dir, and never changes the exit', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), async t => {
  const w = world(t); const hash = (await preview('claude', w.p)).plan_hash;
  let r = await run(['claude', '--settings', w.p, '--apply-plan', 'zz', '--audit-dir', w.audit, '--json'], applyOpts());
  assert.equal(r.code, 64); assert.equal(fs.existsSync(path.join(w.audit, 'hook-installs.jsonl')), false);
  const ww = path.join(w.d, 'ww'); fs.mkdirSync(ww, { mode: 0o700 }); fs.chmodSync(ww, 0o777);
  r = await applyVia('claude', w.p, ww, 'b'.repeat(64));
  assert.equal(r.code, 70); assert.equal(r.json.code, 'plan_changed'); assert.equal(fs.existsSync(path.join(ww, 'hook-installs.jsonl')), false);
  const missing = path.join(w.d, 'missing');
  r = await applyVia('claude', w.p, missing, hash, { env: {} });
  assert.equal(r.code, 77); assert.equal(fs.existsSync(missing), false, 'a refusal must not create the audit dir');
  const link = path.join(w.d, 'lnk'); fs.symlinkSync(w.audit, link);
  r = await applyVia('claude', w.p, link, 'b'.repeat(64));
  assert.equal(r.code, 70); assert.equal(fs.existsSync(path.join(w.audit, 'hook-installs.jsonl')), false);
});

test('audit rotation: > 1 MiB rotates to hook-installs.jsonl.1 (replaced, 0600) before appending', t => {
  const d = tmp(t); const dir = path.join(d, 'audit'); fs.mkdirSync(dir, { mode: 0o700 });
  const f = path.join(dir, 'hook-installs.jsonl'); const f1 = f + '.1';
  fs.writeFileSync(f1, 'old-generation\n', { mode: 0o644 });
  fs.writeFileSync(f, '{"ts":0}\n'.repeat(Math.ceil((1024 * 1024 + 1) / 9)), { mode: 0o600 });
  ui.appendAudit(dir, { ts: 7, event: 'intent' });
  assert.ok(fs.statSync(f1).size > 1024 * 1024); if (process.platform !== 'win32') assertMode(f1, 0o600); // Windows: the fixture is a Node-written file (the helper cannot write >1 MiB); the rotation logic is win-install-fake.test.cjs
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ts":7,"event":"intent"}\n'); assertMode(f, 0o600);
  ui.appendAudit(dir, { ts: 8 }); assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 2); // below the cap: no rotation
});

for (const harness of ['recap', 'statusline']) test(`${harness}: user preview, bound apply, audit and marker-only removal`, async t => {
  const d = tmp(t); fs.mkdirSync(path.join(d, '.claude'));
  const p = path.join(d, '.claude/settings.json'), audit = path.join(d, 'audit');
  const original = '{"model":"keep","statusLine":{"type":"command","command":"mine"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"third"}]}]}}\n';
  fs.writeFileSync(p, original);
  const opts = { env: { HOME: d, ABITO_ISLAND_EXE: EXE }, homedir: () => d, readExe: () => EXE };
  const call = more => run([harness, '--user', ...more, '--json'], opts);
  let r = await call([]);
  assert.equal(r.code, 0, r.lines[0]);
  assert.deepEqual(r.json.entries.map(e => e.event), harness === 'recap' ? ['UserPromptSubmit', 'PostToolUse', 'Stop'] : ['statusLine']);
  assert.equal(fs.readFileSync(p, 'utf8'), original);
  assert.deepEqual(ls(d), ['.claude']);
  const apply = hash => call(['--apply-plan', hash, '--audit-dir', audit]);
  assert.equal((await apply('a'.repeat(64))).json.code, 'plan_changed');
  assert.equal(fs.existsSync(audit), false);
  const hash = r.json.plan_hash;
  const guard = await run([harness, '--user', '--apply-plan', hash, '--audit-dir', audit, '--json'], { ...opts, env: { HOME: d } });
  assert.equal(guard.json.code, 'not_island');
  const noAudit = await call(['--apply-plan', hash, '--audit-dir', path.join(d, 'missing/audit')]);
  assert.equal(noAudit.json.code, 'audit_unavailable');
  assert.equal(fs.existsSync(path.join(d, '.abito')), false);
  assert.equal(fs.readFileSync(p, 'utf8'), original);
  assert.equal((await call(['--timeout-sec', '5'])).json.code, 'usage');
  r = await apply(hash); assert.equal(r.code, 0, r.lines[0]);
  assert.equal(fs.readFileSync(r.json.backup, 'utf8'), original);
  if (harness === 'statusline') {
    const saved = path.join(d, '.abito/statusline-previous.json');
    assertMode(saved, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(saved)).command, 'mine');
  }
  assert.equal((await call([])).json.changed, false);
  const rm = await call(['--remove']);
  assert.ok(rm.json.entries.every(e => e.op === 'remove'));
  r = await call(['--remove', '--apply-plan', rm.json.plan_hash, '--audit-dir', audit]);
  assert.equal(r.code, 0, r.lines[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(p)), JSON.parse(original));
  assert.equal((await call(['--remove'])).json.changed, false);
  assert.doesNotMatch(JSON.stringify(auditLines(audit)), /mine|third|model|command/);
});

test('BIN path constant in preview is this package bin', async t => {
  const d = tmp(t); const p = path.join(d, 'settings.json');
  const r = await run(['claude', '--settings', p, '--json']);
  assert.ok(r.lines[0].includes(JSON.stringify(BIN).slice(1, -1)) || r.json.diff.lines.some(l => l.includes(BIN)) || r.lines[0].includes(JSON.stringify(JSON.stringify(BIN).slice(1, -1)).slice(1, -1)));
});

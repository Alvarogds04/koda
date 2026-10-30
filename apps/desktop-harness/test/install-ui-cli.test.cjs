'use strict';
const { tmpBase, assertMode, unixOnly } = require('./platform-env.cjs');
// End-to-end tests of `abito-hook install <claude|codex> ... --json / --apply-plan` through REAL child processes.
// The CLI is started by a wrapper node process, so its parent executable is node (ABITO_ISLAND_EXE = realpath(node)).
// Temp dirs only; the real ~/.claude and ~/.codex are never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('../src/install-claude.cjs');
const codex = require('../src/install-codex.cjs');

const BIN = path.resolve(__dirname, '../bin/abito-hook.cjs');
const NODE_REAL = fs.realpathSync(process.execPath);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'AI_AGENT', 'GENTLE_PI_SESSION'];

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-instuicli-')));
  fs.chmodSync(d, 0o700);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const ls = d => fs.readdirSync(d).sort();
function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ABITO_ISLAND_EXE: NODE_REAL, ...extra }; // Windows os.homedir() reads USERPROFILE
  for (const k of Object.keys(env)) if (MARKERS.includes(k) || k === 'OPENCODE' || k.startsWith('OPENCODE_')) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}
// Wrapper node process: runs every arg list concurrently as its own child and reports {status, stdout, stderr} for each.
const WRAP = `
const { spawn } = require('node:child_process');
const [bin, lists] = [process.argv[1], JSON.parse(process.argv[2])];
Promise.all(lists.map(a => new Promise(res => {
  const c = spawn(process.execPath, [bin, ...a], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
  c.on('close', s => res({ status: s, stdout: o, stderr: e }));
}))).then(r => process.stdout.write(JSON.stringify(r)));`;
function runMany(lists, env) {
  const w = spawnSync(process.execPath, ['-e', WRAP, BIN, JSON.stringify(lists)], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(w.status, 0, w.stderr);
  return JSON.parse(w.stdout).map(r => {
    assert.equal(r.stderr, '', 'stderr must be empty in --json mode');
    const lines = r.stdout.split('\n');
    assert.equal(lines.length, 2); assert.equal(lines[1], '');
    return { code: r.status, json: JSON.parse(lines[0]), raw: lines[0] };
  });
}
const cli = (args, env) => runMany([['install', ...args]], env)[0];

test('Windows UI install with an unverifiable install manifest refuses before reading settings or creating audit/backup/lock files (HU-047 fail closed)', t => {
  const dir = tmp(t);
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, '{"keep":true}\n');
  const before = fs.readFileSync(settings);
  // On a real Windows runner the checkout has a valid manifest and helper (win-fixture.test.cjs), so the untrusted layout is built here:
  // the CLI copied next to NO abito-install.json (its install root is two levels above src/).
  let bin = BIN;
  if (process.platform === 'win32') {
    const root = path.join(dir, 'untrusted-install', 'desktop-harness');
    const pkg = path.resolve(path.dirname(BIN), '..');
    for (const sub of ['bin', 'src']) fs.cpSync(path.join(pkg, sub), path.join(root, sub), { recursive: true });
    bin = path.join(root, 'bin', 'abito-hook.cjs');
  }
  for (const harness of ['claude', 'codex', 'copilot', 'opencode', 'recap', 'statusline']) {
    for (const extra of [[], ['--apply-plan', 'a'.repeat(64), '--audit-dir', path.join(dir, 'audit')]]) {
      const args = ['install', harness, '--settings', settings, '--json', ...extra];
      const script = "Object.defineProperty(process,'platform',{value:'win32'}); process.getuid=undefined; process.argv=[process.execPath,...JSON.parse(process.argv[1])]; require(process.argv[1]);";
      const result = spawnSync(process.execPath, ['-e', script, JSON.stringify([bin, ...args])], {encoding:'utf8', timeout:5000});
      assert.equal(result.status, 65, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify({schema:'abito-hook-install/1',ok:false,code:'install_unverified',message:'the installed Koda files could not be verified; nothing was written'}) + '\n');
      assert.deepEqual(fs.readdirSync(dir).filter(n => n !== 'untrusted-install'), ['settings.json']);
      assert.deepEqual(fs.readFileSync(settings), before);
    }
  }
});

function world(t, { harness = 'claude', content = '{\n  "keep": true\n}\n' } = {}) {
  const d = tmp(t);
  const home = path.join(d, 'home'); fs.mkdirSync(path.join(home, harness === 'claude' ? '.claude' : '.codex'), { recursive: true });
  const settings = path.join(d, 'settings.json');
  if (content !== null) fs.writeFileSync(settings, content, { mode: 0o640 });
  const audit = path.join(d, 'audit');
  return { d, home, settings, audit, env: cleanEnv(home) };
}
const base = (w, harness, extra = []) => [harness, '--settings', w.settings, ...extra];
const previewOf = (w, harness, extra = []) => cli([...base(w, harness, extra), '--json'], w.env);
const applyArgs = (w, harness, hash, extra = []) => [...base(w, harness, extra), '--apply-plan', hash, '--audit-dir', w.audit, '--json'];
const snap = w => ({ ls: ls(w.d), bytes: fs.existsSync(w.settings) ? fs.readFileSync(w.settings) : null });
function assertUntouched(w, before) {
  assert.deepEqual(ls(w.d), before.ls);
  const now = fs.existsSync(w.settings) ? fs.readFileSync(w.settings) : null;
  assert.ok((now === null && before.bytes === null) || (now && before.bytes && now.equals(before.bytes)), 'settings bytes changed');
}
const expectedAfter = (w, harness, o = {}) => (harness === 'codex' ? codex.planCodexHooks : core.planClaudeSettings)({ settingsPath: w.settings, ...o }).after;

for (const harness of ['claude', 'codex']) {
  test(`${harness}: preview over a real process is one JSON line, empty stderr, and writes nothing`, t => {
    const w = world(t, { harness }); const before = snap(w);
    const r = previewOf(w, harness);
    assert.equal(r.code, 0); assert.equal(r.json.mode, 'preview'); assert.equal(r.json.harness, harness);
    assert.equal(r.json.requires_trust_review, harness === 'codex');
    assertUntouched(w, before);
    assert.equal(fs.existsSync(w.audit), false);
  });

  test(`${harness}: apply-plan applies exactly the previewed plan; backup, audit, rollback`, t => {
    const w = world(t, { harness }); const orig = fs.readFileSync(w.settings);
    const p = previewOf(w, harness).json;
    const want = expectedAfter(w, harness);
    const r = cli(applyArgs(w, harness, p.plan_hash), w.env);
    assert.equal(r.code, 0, r.raw);
    const j = r.json;
    assert.deepEqual(Object.keys(j).sort(), ['action', 'backup', 'changed', 'entries', 'harness', 'mode', 'ok', 'plan_hash', 'requires_trust_review', 'rollback', 'schema', 'target'].sort());
    assert.equal(j.mode, 'applied'); assert.equal(j.ok, true); assert.equal(j.plan_hash, p.plan_hash); assert.equal(j.changed, true);
    assert.equal(j.requires_trust_review, harness === 'codex'); assert.deepEqual(j.entries, p.entries);
    assert.equal(fs.readFileSync(w.settings, 'utf8'), want);
    assert.ok(path.isAbsolute(j.backup) && j.backup.startsWith(w.settings + '.abito-backup-'));
    assertMode(j.backup, 0o600);
    assert.ok(fs.readFileSync(j.backup).equals(orig));
    // audit: intent + result, metadata only
    const af = path.join(w.audit, 'hook-installs.jsonl');
    assertMode(w.audit, 0o700); assertMode(af, 0o600);
    const raw = fs.readFileSync(af, 'utf8'); const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'event', 'harness', 'plan_hash', 'target', 'ts']);
    assert.equal(lines[0].event, 'intent'); assert.equal(lines[0].plan_hash, p.plan_hash); assert.equal(lines[0].harness, harness); assert.equal(lines[0].action, 'install');
    assert.deepEqual(Object.keys(lines[1]).sort(), ['backup', 'code', 'event', 'ok', 'plan_hash', 'ts']);
    assert.equal(lines[1].event, 'result'); assert.equal(lines[1].ok, true); assert.equal(lines[1].backup, j.backup);
    assert.ok(Number.isInteger(lines[0].ts));
    assert.ok(!raw.includes(JSON.stringify(BIN).slice(1, -1)) && !raw.includes('command') && !raw.includes('keep'));
    // rollback string restores the original
    if (process.platform !== 'win32') { // the rollback hint is a POSIX command line (cp/mv/rm); the Windows hint is covered by win-install-fake.test.cjs
      const sh = spawnSync('sh', ['-c', j.rollback], { encoding: 'utf8' });
      assert.equal(sh.status, 0);
      assert.ok(fs.readFileSync(w.settings).equals(orig));
    }
  });

  test(`${harness}: new file => backup null, rollback deletes the file`, t => {
    const w = world(t, { harness, content: null });
    const p = previewOf(w, harness).json; assert.equal(p.exists, false);
    const r = cli(applyArgs(w, harness, p.plan_hash), w.env);
    assert.equal(r.code, 0, r.raw); assert.equal(r.json.backup, null);
    assert.ok(fs.readFileSync(w.settings, 'utf8').includes(JSON.stringify(BIN).slice(1, -1)));
    assertMode(w.settings, 0o600);
    if (process.platform !== 'win32') { // the rollback hint is a POSIX `rm --` command line; the Windows hint is covered by win-install-fake.test.cjs
      assert.ok(r.json.rollback.startsWith('rm -- '));
      assert.equal(spawnSync('sh', ['-c', r.json.rollback]).status, 0);
      assert.equal(fs.existsSync(w.settings), false);
    }
  });

  test(`${harness}: --remove is symmetric; re-apply is an idempotent no-op without a new backup`, t => {
    const w = world(t, { harness });
    let p = previewOf(w, harness).json;
    assert.equal(cli(applyArgs(w, harness, p.plan_hash), w.env).code, 0);
    const installed = fs.readFileSync(w.settings, 'utf8');
    // idempotent: preview is changed:false, apply-plan of that hash is a no-op
    p = previewOf(w, harness).json; assert.equal(p.changed, false); assert.ok(p.entries.length >= 2 && p.entries.every(e => e.op === 'keep'));
    const n = ls(w.d).length;
    const r = cli(applyArgs(w, harness, p.plan_hash), w.env);
    assert.equal(r.code, 0, r.raw); assert.equal(r.json.changed, false); assert.equal(r.json.backup, null); assert.equal(r.json.rollback, null);
    assert.equal(ls(w.d).length, n); assert.equal(fs.readFileSync(w.settings, 'utf8'), installed);
    // remove
    p = previewOf(w, harness, ['--remove']).json; assert.equal(p.action, 'remove'); assert.ok(p.entries.length >= 2 && p.entries.every(e => e.op === 'remove'));
    const rr = cli(applyArgs(w, harness, p.plan_hash, ['--remove']), w.env);
    assert.equal(rr.code, 0, rr.raw); assert.equal(rr.json.action, 'remove'); assert.equal(rr.json.requires_trust_review, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.settings, 'utf8')), { keep: true });
    assert.ok(!fs.readFileSync(w.settings, 'utf8').includes(JSON.stringify(BIN).slice(1, -1)));
  });
}

test('--user with a temp HOME works for codex and claude', t => {
  for (const [harness, dir, file] of [['codex', '.codex', 'hooks.json'], ['claude', '.claude', 'settings.json']]) {
    const w = world(t, { harness });
    const target = path.join(w.home, dir, file); fs.writeFileSync(target, '{"x":1}\n');
    const p = cli([harness, '--user', '--json'], w.env);
    assert.equal(p.code, 0, p.raw); assert.equal(p.json.target, target);
    const r = cli([harness, '--user', '--apply-plan', p.json.plan_hash, '--audit-dir', w.audit, '--json'], w.env);
    assert.equal(r.code, 0, r.raw); assert.ok(fs.readFileSync(target, 'utf8').includes(JSON.stringify(BIN).slice(1, -1)));
  }
});

function refusal(name, { harness = 'claude', code, jcode, setup, env, content, args }) {
  test('refusal: ' + name, t => {
    const w = world(t, { harness, content });
    const p = previewOf(w, harness).json;
    const mutate = setup ? setup(w, p) : undefined;
    const before = snap(w);
    const e = env ? env(w) : w.env;
    const hash = (mutate && mutate.hash) || p.plan_hash;
    const r = cli(args ? args(w, hash) : applyArgs(w, harness, hash), e);
    assert.equal(r.code, code, r.raw); assert.equal(r.json.ok, false); assert.equal(r.json.schema, 'abito-hook-install/1');
    assert.equal(r.json.code, jcode);
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'message', 'ok', 'schema']);
    assertUntouched(w, before);
    if (code !== 73 || !fs.existsSync(w.audit)) assert.equal(fs.existsSync(path.join(w.audit, 'hook-installs.jsonl')), false);
  });
}
refusal('no ABITO_ISLAND_EXE', { code: 77, jcode: 'not_island', env: w => cleanEnv(w.home, { ABITO_ISLAND_EXE: undefined }) });
refusal('wrong ABITO_ISLAND_EXE', { code: 77, jcode: 'not_island', env: w => cleanEnv(w.home, { ABITO_ISLAND_EXE: fs.realpathSync(process.platform === 'win32' ? process.env.ComSpec : '/bin/sh') }) });
refusal('relative ABITO_ISLAND_EXE', { code: 77, jcode: 'not_island', env: w => cleanEnv(w.home, { ABITO_ISLAND_EXE: 'node' }) });
for (const m of [...MARKERS, 'OPENCODE', 'OPENCODE_FOO']) {
  refusal('agent marker ' + m, { code: 77, jcode: 'not_island', env: w => cleanEnv(w.home, { [m]: '1' }) });
}
refusal('stale hash', { code: 70, jcode: 'plan_changed', setup: () => ({ hash: '0'.repeat(64) }) });
refusal('hash of another sha', { code: 70, jcode: 'plan_changed', setup: () => ({ hash: sha('x') }) });
refusal('file modified between preview and apply', { code: 70, jcode: 'plan_changed', setup: w => { fs.writeFileSync(w.settings, '{"keep": false}\n'); } });
refusal('file deleted between preview and apply', { code: 70, jcode: 'plan_changed', setup: w => { fs.unlinkSync(w.settings); } });
refusal('hash from a different harness', { code: 70, jcode: 'plan_changed', args: (w, h) => applyArgs(w, 'codex', h) });
refusal('hash from different args (timeout)', { code: 70, jcode: 'plan_changed', args: (w, h) => applyArgs(w, 'claude', h, ['--timeout-sec', '50']) });
refusal('hash from different action (remove)', { code: 70, jcode: 'plan_changed', args: (w, h) => applyArgs(w, 'claude', h, ['--remove']) });
refusal('malformed hash', { code: 64, jcode: 'usage', setup: () => ({ hash: 'abc' }) });
refusal('uppercase hash', { code: 64, jcode: 'usage', setup: (w, p) => ({ hash: p.plan_hash.toUpperCase() }) });
refusal('--apply together with --json', { code: 64, jcode: 'usage', args: w => [...base(w, 'claude'), '--apply', '--json'] });
refusal('--apply together with --apply-plan', { code: 64, jcode: 'usage', args: (w, h) => [...applyArgs(w, 'claude', h), '--apply'] });
refusal('--apply-plan without --json', { code: 64, jcode: 'usage', args: (w, h) => [...base(w, 'claude'), '--apply-plan', h, '--audit-dir', w.audit] });
refusal('--apply-plan without --audit-dir', { code: 64, jcode: 'usage', args: (w, h) => [...base(w, 'claude'), '--apply-plan', h, '--json'] });
refusal('--audit-dir on a preview', { code: 64, jcode: 'usage', args: w => [...base(w, 'claude'), '--audit-dir', w.audit, '--json'] });
refusal('duplicate --apply-plan', { code: 64, jcode: 'usage', args: (w, h) => [...applyArgs(w, 'claude', h), '--apply-plan', h] });
refusal('relative --audit-dir', { code: 73, jcode: 'audit_unavailable', args: (w, h) => [...base(w, 'claude'), '--apply-plan', h, '--audit-dir', 'rel/audit', '--json'] });
refusal('symlinked settings', {
  code: 65, jcode: process.platform === 'win32' ? 'unsafe_target' : 'refused', content: null, // Windows: the helper reports the link as an unsafe target
  setup: w => { fs.writeFileSync(path.join(w.d, 'real.json'), '{}\n'); fs.symlinkSync(path.join(w.d, 'real.json'), w.settings); },
});
refusal('bad UTF-8 settings', { code: 65, jcode: 'refused', content: '{}\n', setup: w => { fs.writeFileSync(w.settings, Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d])); } });

const auditCase = (name, prep, unix = true) => test('audit unavailable => 73 and settings untouched: ' + name, unix ? unixOnly('win-install-fake.test.cjs audit refusals through the helper contract') : {}, t => {
  if (process.getuid?.() === 0) return t.skip('root ignores permission bits');
  const w = world(t);
  const p = previewOf(w, 'claude').json;
  prep(w);
  const before = snap(w);
  const r = cli(applyArgs(w, 'claude', p.plan_hash), w.env);
  assert.equal(r.code, 73, r.raw); assert.equal(r.json.code, 'audit_unavailable');
  assertUntouched(w, before);
});
auditCase('unwritable dir', w => { fs.mkdirSync(w.audit, { mode: 0o700 }); fs.chmodSync(w.audit, 0o500); });
auditCase('missing parent', w => { w.audit = path.join(w.d, 'no', 'such', 'audit'); }, false);
auditCase('symlink dir', w => { fs.mkdirSync(path.join(w.d, 'real-audit'), { mode: 0o700 }); fs.symlinkSync(path.join(w.d, 'real-audit'), w.audit); });
auditCase('world-writable dir', w => { fs.mkdirSync(w.audit, { mode: 0o700 }); fs.chmodSync(w.audit, 0o777); });
auditCase('audit file is a symlink', w => { fs.mkdirSync(w.audit, { mode: 0o700 }); fs.symlinkSync(path.join(w.d, 'target'), path.join(w.audit, 'hook-installs.jsonl')); });
auditCase('audit file wrong mode', w => { fs.mkdirSync(w.audit, { mode: 0o700 }); const f = path.join(w.audit, 'hook-installs.jsonl'); fs.writeFileSync(f, ''); fs.chmodSync(f, 0o666); });
test('audit unavailable: foreign-owner directory (/usr) => 73', t => {
  if (process.getuid?.() === 0) return t.skip('root owns /usr');
  const w = world(t);
  const p = previewOf(w, 'claude').json; const before = snap(w);
  const r = cli([...base(w, 'claude'), '--apply-plan', p.plan_hash, '--audit-dir', '/usr', '--json'], w.env);
  assert.equal(r.code, 73); assert.equal(r.json.code, 'audit_unavailable'); assertUntouched(w, before);
});

test('a second apply of an already used hash sees plan_changed and never corrupts the file', t => {
  const w = world(t);
  const p = previewOf(w, 'claude').json;
  assert.equal(cli(applyArgs(w, 'claude', p.plan_hash), w.env).code, 0);
  const after = fs.readFileSync(w.settings); const n = ls(w.d).length;
  const r = cli(applyArgs(w, 'claude', p.plan_hash), w.env);
  assert.equal(r.code, 70); assert.equal(r.json.code, 'plan_changed');
  assert.ok(fs.readFileSync(w.settings).equals(after)); assert.equal(ls(w.d).length, n);
});

test('concurrency: simultaneous applies of the same hash => exactly one succeeds, the other plan_changed, file valid', unixOnly('win-install-fake.test.cjs (HU-047 Windows flow through the helper contract) + smoke-windows.ps1 on the installed helper'), t => {
  for (let round = 0; round < 3; round++) {
    const w = world(t);
    const p = previewOf(w, 'claude').json;
    const want = expectedAfter(w, 'claude');
    const rs = runMany([['install', ...applyArgs(w, 'claude', p.plan_hash)], ['install', ...applyArgs(w, 'claude', p.plan_hash)], ['install', ...applyArgs(w, 'claude', p.plan_hash)]], w.env);
    const oks = rs.filter(r => r.code === 0), bad = rs.filter(r => r.code !== 0);
    assert.equal(oks.length, 1, JSON.stringify(rs.map(r => r.raw)));
    for (const b of bad) { assert.equal(b.code, 70); assert.equal(b.json.code, 'plan_changed'); }
    assert.equal(fs.readFileSync(w.settings, 'utf8'), want);
    assert.equal(ls(w.d).filter(f => f.includes('.abito-backup-')).length, 1);
    assert.deepEqual(ls(w.d).filter(f => f.includes('abito-tmp') || f.includes('abito-lock')), []);
  }
});

// ---- EPIPE / crash contract ----
const { spawn } = require('node:child_process');
const FIXED_INTERNAL = '{"schema":"abito-hook-install/1","ok":false,"code":"internal","message":"internal error"}\n';
// Starts the CLI with the read end of its stdout pipe closed at once (optionally preloading a script that sabotages the run).
function runClosed(args, env, preload, { closeStdout = true } = {}) {
  return new Promise(resolve => {
    const nodeArgs = preload ? ['--require', preload, BIN, ...args] : [BIN, ...args];
    const c = spawn(process.execPath, nodeArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stderr.on('data', d => { err += d; }); c.stdout.on('data', d => { out += d; });
    if (closeStdout) c.stdout.destroy();
    c.on('close', status => resolve({ status, out, err }));
  });
}
function preloadFile(t, body) {
  const d = tmp(t); const f = path.join(d, 'preload.cjs');
  fs.writeFileSync(f, `const ui = require(${JSON.stringify(path.resolve(__dirname, '../src/install-ui.cjs'))});\n${body}\n`);
  return f;
}

test('closed stdout pipe: preview exits 0 with empty stderr (no EPIPE stack)', async t => {
  const w = world(t);
  const r = await runClosed(['install', ...base(w, 'claude'), '--json'], w.env);
  assert.equal(r.err, ''); assert.equal(r.status, 0);
});
test('closed stdout pipe: apply is applied, audited, exit 0 and silent', async t => {
  const w = world(t); const p = previewOf(w, 'claude').json;
  const r = await runClosed(['install', ...applyArgs(w, 'claude', p.plan_hash)], w.env);
  assert.equal(r.err, ''); assert.equal(r.status, 0);
  assert.ok(fs.readFileSync(w.settings, 'utf8').includes(JSON.stringify(BIN).slice(1, -1)));
  assert.equal(fs.readFileSync(path.join(w.audit, 'hook-installs.jsonl'), 'utf8').trim().split('\n').length, 2);
});
test('closed stdout pipe: a refusal keeps its own exit code (plan_changed => 70)', async t => {
  const w = world(t);
  const r = await runClosed(['install', ...applyArgs(w, 'claude', 'c'.repeat(64))], w.env);
  assert.equal(r.err, ''); assert.equal(r.status, 70);
});
test('crash before any output: ONE fixed internal JSON error and exit 70, empty stderr', async t => {
  const w = world(t);
  for (const body of [
    'ui.runInstallUi = () => new Promise(() => { setTimeout(() => { throw new Error("boom"); }, 5); });',
    'ui.runInstallUi = () => new Promise(() => { setTimeout(() => { Promise.reject(new Error("boom")); }, 5); });',
  ]) {
    const r = await runClosed(['install', ...base(w, 'claude'), '--json'], w.env, preloadFile(t, body), { closeStdout: false });
    assert.equal(r.status, 70); assert.equal(r.out, FIXED_INTERNAL); assert.equal(r.err, '');
  }
});
test('crash AFTER the result JSON was produced: no stack, exit code matches that JSON', async t => {
  const w = world(t);
  const cases = [[{ ok: true, mode: 'applied' }, 0], [{ ok: false, code: 'plan_changed' }, 70], [{ ok: false, code: 'not_island' }, 77], [{ ok: false, code: 'not_writable' }, 65], [{ ok: false, code: 'audit_unavailable' }, 73]];
  for (const [obj, exit] of cases) for (const [closeStdout, thrower] of [[false, 'throw new Error("boom")'], [true, 'Promise.reject(new Error("boom"))']]) {
    const body = `ui.runInstallUi = (argv, opts) => { const o = Object.assign({ schema: 'abito-hook-install/1' }, ${JSON.stringify(obj)}); opts.onJson(o); opts.out(JSON.stringify(o) + '\\n'); setTimeout(() => { ${thrower}; }, 30); return new Promise(() => {}); };`;
    const r = await runClosed(['install', ...base(w, 'claude'), '--json'], w.env, preloadFile(t, body), { closeStdout });
    assert.equal(r.status, exit, JSON.stringify(obj)); assert.equal(r.err, '');
    if (!closeStdout) assert.equal(r.out.split('\n').length, 2);
  }
});

test('TTY installers still reject the new flags (usage 64, text on stderr)', t => {
  const d = tmp(t);
  const r = spawnSync(process.execPath, [BIN, 'install', 'claude', '--settings', path.join(d, 's.json'), '--bogus'], { encoding: 'utf8', timeout: 20000, env: cleanEnv(d) });
  assert.equal(r.status, 64); assert.match(r.stderr, /^usage: abito-hook install claude/);
});

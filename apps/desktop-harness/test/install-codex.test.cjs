'use strict';
const { tmpBase, assertMode, unixOnly } = require('./platform-env.cjs');
// Temp dirs only (mkdtemp under tmpBase()); the real ~/.codex is never touched.
// K2-08 T3 (S2, S4, S5): PermissionRequest is ANSWERED from the island — `--timeout-sec 120`, timeout 120 s, statusMessage
// «Esperando tu respuesta en Koda». PreToolUse with matcher `request_user_input` (plan-mode questions), PostToolUse and
// Stop stay the bounded notice/clearing entries of S4/T2. Older Koda entries (5 s notice, any `--timeout-sec N`) migrate in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cx = require('../src/install-codex.cjs');

const BIN = path.resolve(__dirname, '../bin/abito-hook.cjs');
function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'abito-instcodex-')));
  fs.chmodSync(d, 0o700);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const moshi = c => ({ type: 'command', command: c, timeout: 10 });
// A realistic third-party file: moshi-hook and herdr-agent-state.sh must survive install, migration and removal.
const FIX = '{\n  "description": "third \\u00e9 party",\n  "big": 12345678901234567890,\n  "hooks": {\n    "PermissionRequest": [{"hooks": [{"type": "command", "command": "moshi-hook perm", "timeout": 10}, {"type": "command", "command": "herdr-agent-state.sh permission"}]}],\n    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "herdr-agent-state.sh tool"}]}],\n    "SessionStart": [{"hooks": [{"type": "command", "command": "moshi-hook start"}]}],\n    "Stop": [{"hooks": [{"type": "command", "command": "moshi-hook stop"}]}],\n    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "moshi-hook prompt"}]}]\n  },\n  "tail": [1, 2]\n}\n';
function fixture(d, text = FIX) { const p = path.join(d, 'hooks.json'); fs.writeFileSync(p, text, { mode: 0o600 }); return p; }
function io(extra = {}) {
  const r = { out: '', err: '', prompts: [] };
  r.opts = { out: s => { r.out += s; }, err: s => { r.err += s; }, isTTY: () => true, uid: process.getuid?.(), prompt: async q => { r.prompts.push(q); return 'install'; }, now: () => new Date('2026-01-02T03:04:05.678Z'), ...extra };
  return r;
}
const ls = d => fs.readdirSync(d).sort();
const plan = (p, o = {}) => cx.planCodexHooks({ settingsPath: p, ...o });
const q = cx.shellQuote;
// K2-08 T3 (S2, S4, S5): PermissionRequest is the ANSWERED entry — `--timeout-sec 120`, a 120 s timeout and the Spanish
// statusMessage Codex shows while it waits; the three notice entries keep their bounded 5 s / 15 s shape. On Windows
// drive paths every entry also carries the cmd-style `commandWindows` (Codex runs hooks with `cmd /C` there).
const SUBS = { PermissionRequest: 'permission-request --timeout-sec 120', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', Stop: 'stop' };
const WAITING = 'Esperando tu respuesta en Koda';
const isWin = p => /^[A-Za-z]:\\/.test(p);
function entryOf(ev, node = process.execPath, bin = BIN) {
  const e = { type: 'command', command: `${q(node)} ${q(bin)} codex ${SUBS[ev]}` };
  if (isWin(node) && isWin(bin)) e.commandWindows = `""${node}" "${bin}" codex ${SUBS[ev]}"`;
  e.timeout = ev === 'PermissionRequest' ? 120 : ev === 'Stop' ? 15 : 5;
  e.statusMessage = ev === 'PermissionRequest' ? WAITING : 'Koda island';
  return e;
}
const NOTICE_ENTRIES = Object.fromEntries(Object.keys(SUBS).map(ev => [ev, entryOf(ev)]));
// The exact entries the notice-era installer (S4/T2, before T3) wrote: what an upgrade finds on disk.
const T2_ENTRIES = {
  PermissionRequest: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex permission-request`, timeout: 5, statusMessage: 'Koda island' },
  PreToolUse: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex pre-tool-use`, timeout: 5, statusMessage: 'Koda island' },
  PostToolUse: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex post-tool-use`, timeout: 5, statusMessage: 'Koda island' },
  Stop: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex stop`, timeout: 15, statusMessage: 'Koda island' },
};

test('install adds exactly our four groups (three next to existing ones, PostToolUse new); outside hooks byte-exact; third-party semantically exact', t => {
  const d = tmp(t); const p = fixture(d);
  const pl = plan(p);
  const orig = JSON.parse(FIX), got = JSON.parse(pl.after);
  const pre = FIX.slice(0, FIX.indexOf('"hooks"')), suf = FIX.slice(FIX.indexOf('  "tail"'));
  assert.ok(pl.after.startsWith(pre) && pl.after.endsWith(suf));
  assert.deepEqual(got.hooks.SessionStart, orig.hooks.SessionStart);
  assert.deepEqual(got.hooks.UserPromptSubmit, orig.hooks.UserPromptSubmit);
  // the existing groups (including the foreign PreToolUse matcher group) are untouched, ours is appended
  for (const ev of ['PermissionRequest', 'PreToolUse', 'Stop']) {
    assert.deepEqual(got.hooks[ev][0], orig.hooks[ev][0], ev);
    assert.equal(got.hooks[ev].length, 2, ev);
    assert.deepEqual(Object.keys(got.hooks[ev][1]).sort(), ev === 'PreToolUse' ? ['hooks', 'matcher'] : ['hooks'], ev);
    assert.deepEqual(got.hooks[ev][1].hooks[0], NOTICE_ENTRIES[ev], ev);
  }
  // PostToolUse did not exist in the file: the clearing entry is a single new group of its own
  assert.deepEqual(got.hooks.PostToolUse, [{ hooks: [NOTICE_ENTRIES.PostToolUse] }]);
  // PreToolUse is installed under the plan-mode question matcher; PermissionRequest and Stop keep no matcher.
  assert.equal(got.hooks.PreToolUse[1].matcher, 'request_user_input');
  assert.equal(got.hooks.PermissionRequest[1].matcher, undefined);
  assert.equal(got.hooks.PostToolUse[0].matcher, undefined, 'PostToolUse watches EVERY tool: a pending approval blocks the turn');
  assert.equal(got.hooks.Stop[1].matcher, undefined);
  assert.deepEqual(ls(d), ['hooks.json']);
  assert.deepEqual(cx.CODEX_PROFILE.events, ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']);
});

test('only PermissionRequest waits (120 s, --timeout-sec 120, «Esperando tu respuesta en Koda»); the notices stay bounded', t => {
  const d = tmp(t); const p = fixture(d);
  const after = JSON.parse(plan(p).after);
  const perm = after.hooks.PermissionRequest.at(-1).hooks[0];
  assert.ok(perm.command.endsWith(' codex permission-request --timeout-sec 120'), perm.command);
  assert.equal(perm.timeout, 120, 'Codex hook timeouts are in SECONDS');
  assert.equal(perm.statusMessage, WAITING);
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const h = after.hooks[ev].at(-1).hooks[0];
    assert.doesNotMatch(h.command, /--timeout-sec/, ev);
    assert.ok(h.timeout <= 15, `${ev}: a notice is bounded (${h.timeout}s)`);
  }
});

test('fresh install (no hooks.json yet) writes exactly the four Koda entries', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  const pl = plan(p);
  assert.equal(pl.exists, false);
  assert.deepEqual(JSON.parse(pl.after), { hooks: {
    PermissionRequest: [{ hooks: [NOTICE_ENTRIES.PermissionRequest] }],
    PreToolUse: [{ matcher: 'request_user_input', hooks: [NOTICE_ENTRIES.PreToolUse] }],
    PostToolUse: [{ hooks: [NOTICE_ENTRIES.PostToolUse] }],
    Stop: [{ hooks: [NOTICE_ENTRIES.Stop] }],
  } });
});

test('upgrade from the 5 s notice install: PermissionRequest migrated in place, other tools untouched, no duplicates, second run no-op, remove only ours', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  const before = {
    model: 'kept',
    hooks: {
      PermissionRequest: [{ hooks: [moshi('moshi-hook perm'), T2_ENTRIES.PermissionRequest, moshi('herdr-agent-state.sh permission')] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [moshi('herdr-agent-state.sh tool')] }, { matcher: 'request_user_input', hooks: [T2_ENTRIES.PreToolUse] }],
      PostToolUse: [{ hooks: [T2_ENTRIES.PostToolUse, moshi('herdr-agent-state.sh post')] }],
      SessionStart: [{ hooks: [moshi('moshi-hook start')] }],
      Stop: [{ hooks: [moshi('moshi-hook stop')] }, { hooks: [T2_ENTRIES.Stop] }],
    },
  };
  fs.writeFileSync(p, JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
  const pl = plan(p);
  // On a Windows drive path the notice-era entries lack `commandWindows` (cmd /C could not run them), so all four are
  // replaced there; on POSIX only PermissionRequest changes. Either way every Koda entry ends as a fresh install writes it.
  const win = isWin(process.execPath) && isWin(BIN);
  const notice = win ? 'replace' : 'unchanged';
  assert.deepEqual(pl.actions.map(a => [a.event, a.action]), [['PermissionRequest', 'replace'], ['PreToolUse', notice], ['PostToolUse', notice], ['Stop', notice]]);
  const got = JSON.parse(pl.after);
  assert.equal(got.model, 'kept');
  // replaced IN PLACE, at the same position of the same group; every other tool's hook is byte-for-byte the same
  assert.deepEqual(got.hooks.PermissionRequest, [{ hooks: [moshi('moshi-hook perm'), NOTICE_ENTRIES.PermissionRequest, moshi('herdr-agent-state.sh permission')] }]);
  for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop']) assert.deepEqual(got.hooks[ev], before.hooks[ev], ev);
  const ours = Object.values(got.hooks).flat().flatMap(g => g.hooks).filter(h => h.command.startsWith(`${q(process.execPath)} ${q(BIN)} codex `)).length;
  assert.equal(ours, 4, 'exactly one Koda entry per event, no duplicates');
  fs.writeFileSync(p, pl.after);
  assert.equal(plan(p).changed, false, 'a second install run is a no-op');
  const rm = JSON.parse(plan(p, { remove: true }).after);
  assert.deepEqual(rm, { model: 'kept', hooks: {
    PermissionRequest: [{ hooks: [moshi('moshi-hook perm'), moshi('herdr-agent-state.sh permission')] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [moshi('herdr-agent-state.sh tool')] }],
    PostToolUse: [{ hooks: [moshi('herdr-agent-state.sh post')] }],
    SessionStart: [{ hooks: [moshi('moshi-hook start')] }],
    Stop: [{ hooks: [moshi('moshi-hook stop')] }],
  } }, 'uninstall removes only Koda');
});

test('idempotent re-install; a --timeout-sec change is inert now; remove restores the original bytes', t => {
  const d = tmp(t); const p = fixture(d);
  const one = plan(p); fs.writeFileSync(p, one.after);
  assert.equal(plan(p).changed, false, 'second run is a no-op');
  const t50 = plan(p, { timeoutSec: 50 });
  assert.equal(t50.changed, false, 'the entries are fixed (S5: 120 s), so the budget flag changes nothing');
  const rm = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(rm.after), JSON.parse(FIX));
  assert.ok(rm.after.startsWith(FIX.slice(0, FIX.indexOf('"hooks"'))) && rm.after.endsWith(FIX.slice(FIX.indexOf('  "tail"'))));
});

test('migration: a legacy answered-install (--timeout-sec 35) is replaced by the T3 entries, foreign hooks untouched, second run no-op', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  // what an existing install of the OLD codex profile looks like (it asked the island and could answer for Codex)
  const legacy = {
    hooks: {
      PermissionRequest: [{ hooks: [moshi('moshi-hook perm'), moshi('herdr-agent-state.sh permission'),
        { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex permission-request --timeout-sec 35`, timeout: 35, statusMessage: 'Koda island' }] }],
      PreToolUse: [{ matcher: 'request_user_input', hooks: [moshi('herdr-agent-state.sh question')] }],
      Stop: [{ hooks: [moshi('moshi-hook stop'), { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex stop`, timeout: 15, statusMessage: 'Koda island' }] }],
    },
  };
  fs.writeFileSync(p, JSON.stringify(legacy, null, 2) + '\n', { mode: 0o600 });
  const pl = plan(p);
  assert.equal(pl.changed, true);
  const got = JSON.parse(pl.after).hooks;
  assert.deepEqual(got.PostToolUse, [{ hooks: [NOTICE_ENTRIES.PostToolUse] }], 'the new clearing entry is added once');
  // our legacy entry is replaced IN PLACE, inside the group it already lived in
  assert.deepEqual(got.PermissionRequest.length, 1);
  assert.deepEqual(got.PermissionRequest[0].hooks.map(h => h.command), ['moshi-hook perm', 'herdr-agent-state.sh permission', NOTICE_ENTRIES.PermissionRequest.command]);
  // the foreign request_user_input group keeps its own hook; ours is appended in a NEW group of the same matcher
  assert.deepEqual(got.PreToolUse[0], { matcher: 'request_user_input', hooks: [moshi('herdr-agent-state.sh question')] });
  assert.deepEqual(got.PreToolUse[1], { matcher: 'request_user_input', hooks: [NOTICE_ENTRIES.PreToolUse] });
  // Stop keeps moshi and swaps nothing (the finished notice never changed)
  assert.deepEqual(got.Stop[0].hooks, [moshi('moshi-hook stop'), NOTICE_ENTRIES.Stop]);
  fs.writeFileSync(p, pl.after);
  assert.equal(plan(p).changed, false, 'migration is idempotent');
  // and removal strips only OUR entries, leaving every foreign hook behind
  const rm = JSON.parse(plan(p, { remove: true }).after).hooks;
  assert.deepEqual(rm, {
    PermissionRequest: [{ hooks: [moshi('moshi-hook perm'), moshi('herdr-agent-state.sh permission')] }],
    PreToolUse: [{ matcher: 'request_user_input', hooks: [moshi('herdr-agent-state.sh question')] }],
    Stop: [{ hooks: [moshi('moshi-hook stop')] }],
  }, 'removal leaves exactly the foreign hooks behind (PostToolUse disappears with our only entry)');
});

test('remove with a shared matcher group leaves third-party hooks untouched', t => {
  const d = tmp(t);
  const ours = { ...NOTICE_ENTRIES.Stop };
  const obj = { hooks: { Stop: [{ matcher: 'x', hooks: [moshi('a'), ours, moshi('b')] }] } };
  const p = path.join(d, 'hooks.json'); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  const rm = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(rm.after).hooks.Stop, [{ matcher: 'x', hooks: [moshi('a'), moshi('b')] }]);
});

test('identification works when the bin path contains quotes', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  const bin = "/tmp/it's a \"dir\"/abito-hook.cjs";
  const pl = plan(p, { binPath: bin });
  fs.writeFileSync(p, pl.after);
  assert.equal(plan(p, { binPath: bin }).changed, false);
  // every event we added is gone; the empty `hooks` object disappears with them
  assert.equal(JSON.parse(plan(p, { binPath: bin, remove: true }).after).hooks, undefined);
});

test('shell quoting matrix through a real sh -c: each path is one intact argument, nothing else runs', unixOnly('POSIX sh quoting of paths with glob/quote characters; Windows paths cannot contain them and are quoted by quoteWindowsCommandPath, covered by win-fs.test.cjs'), t => {
  const d = tmp(t);
  const names = ['a b', "it's", 'dollar$HOME', 'back`id`tick', 'semi;touch PWN', 'amp&touch PWN2', 'ünï©ode', "q'';'", '$(touch PWN3)', '*glob?'];
  for (const n of names) {
    const dir = path.join(d, n); fs.mkdirSync(dir);
    const stub = path.join(dir, 'stub.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o700 });
    const cmd = `${cx.shellQuote(stub)} ${cx.shellQuote(path.join(dir, 'abito hook.cjs'))} codex stop`;
    const r = spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, n + r.stderr);
    assert.deepEqual(r.stdout.split('\0').slice(0, -1), [path.join(dir, 'abito hook.cjs'), 'codex', 'stop'], n);
  }
  assert.deepEqual(ls(d).filter(x => x.startsWith('PWN')), []);
});

test('newline, CR, NUL and relative paths are refused (65)', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  for (const bad of ['/a/b\nc', '/a/b\rc', '/a/b\0c', 'rel/abito.cjs', '']) {
    assert.throws(() => plan(p, { binPath: bad }), e => e.exitCode === 65, JSON.stringify(bad));
    assert.throws(() => plan(p, { execPath: bad }), e => e.exitCode === 65, JSON.stringify(bad));
  }
  assert.throws(() => cx.shellQuote('a\nb'), e => e.exitCode === 65);
});

test('preview names the target, says Koda answers Codex permissions, shows the waiting text and the /hooks re-trust; never the bypass flag', async t => {
  const d = tmp(t); const p = fixture(d); const r = io();
  assert.equal(await cx.runInstallCodex(['codex', '--settings', p], r.opts), 0);
  assert.ok(r.out.includes(p));
  assert.ok(r.out.includes('/hooks'));
  assert.match(r.out, /untrusted|trust/i);
  assert.match(r.out, /trust the Koda hooks again/i, 'after an install or update the human re-trusts them in /hooks');
  assert.match(r.out, /after (every|each) install or update/i);
  assert.match(r.out, /Koda answers Codex permission requests from the island/);
  assert.ok(r.out.includes('«Esperando tu respuesta en Koda»'));
  assert.match(r.out, /120 s/);
  assert.match(r.out, /terminal/);
  assert.doesNotMatch(r.out, /never answers/i, 'the stale notice-only text is gone (verifier D2)');
  assert.ok(!/dangerously/i.test(r.out));
  assert.equal(fs.readFileSync(p, 'utf8'), FIX);
});

test('apply refused without TTY (77); wrong/empty word aborts; right word writes backup 0600 + file', async t => {
  const d = tmp(t); const p = fixture(d);
  let r = io({ isTTY: () => false });
  assert.equal(await cx.runInstallCodex(['codex', '--settings', p, '--apply'], r.opts), 77);
  assert.equal(r.prompts.length, 0);
  for (const w of ['nope', '']) {
    r = io({ prompt: async () => w });
    assert.equal(await cx.runInstallCodex(['codex', '--settings', p, '--apply'], r.opts), 1);
    assert.equal(fs.readFileSync(p, 'utf8'), FIX);
  }
  assert.deepEqual(ls(d), ['hooks.json']);
  r = io();
  assert.equal(await cx.runInstallCodex(['codex', '--settings', p, '--apply'], r.opts), 0, r.err);
  const names = ls(d); assert.equal(names.length, 2);
  const bk = path.join(d, names[1]);
  assert.ok(names[1].startsWith('hooks.json.abito-backup-'));
  assertMode(bk, 0o600);
  assert.equal(fs.readFileSync(bk, 'utf8'), FIX);
  assert.match(r.out, /\/hooks/);
  assert.match(r.out, /trust the Koda hooks again/i, 'the post-apply note repeats the re-trust step');
  assert.ok(!/dangerously/i.test(r.out));
  const installed = JSON.parse(fs.readFileSync(p, 'utf8')).hooks;
  for (const ev of ['PermissionRequest', 'PreToolUse', 'Stop']) assert.equal(installed[ev].length, 2, ev);
  assert.equal(installed.PostToolUse.length, 1, 'the clearing entry is added once (the fixture had no PostToolUse)');
  r = io({ prompt: async () => 'remove', now: () => new Date('2026-01-02T03:04:06.000Z') });
  assert.equal(await cx.runInstallCodex(['codex', '--settings', p, '--remove', '--apply'], r.opts), 0, r.err);
  const back = fs.readFileSync(p, 'utf8');
  assert.deepEqual(JSON.parse(back), JSON.parse(FIX));
  assert.ok(back.startsWith(FIX.slice(0, FIX.indexOf('"hooks"'))) && back.endsWith(FIX.slice(FIX.indexOf('  "tail"'))));
});

test('--user resolves under a temp HOME only; requires existing .codex dir', async t => {
  const home = tmp(t);
  const r = io({ env: { HOME: home }, homedir: () => home });
  assert.equal(await cx.runInstallCodex(['codex', '--user'], r.opts), 65);
  fs.mkdirSync(path.join(home, '.codex'), { mode: 0o700 });
  const r2 = io({ env: { HOME: home }, homedir: () => home });
  assert.equal(await cx.runInstallCodex(['codex', '--user'], r2.opts), 0);
  assert.ok(r2.out.includes(path.join(home, '.codex', 'hooks.json')));
  const r3 = io({ env: { HOME: home }, homedir: () => '/elsewhere' });
  assert.equal(await cx.runInstallCodex(['codex', '--user'], r3.opts), 64);
});

test('usage errors: bad args exit 64', async () => {
  const r = io();
  assert.equal(await cx.runInstallCodex(['codex'], r.opts), 64);
  assert.equal(await cx.runInstallCodex(['claude', '--user'], r.opts), 64);
  assert.match(r.err, /install codex/);
});

// ---- exact-shape ownership (verifier BLOCKER) ----
const Q = cx.shellQuote;
const NODE_Q = Q(process.execPath), BIN_Q = Q(BIN);
const LOOKALIKES = [
  `echo "run ${BIN_Q} codex now"`,
  `grep -rF ${BIN_Q} codex docs/`,
  `logger --msg=${BIN_Q} codex stop ; moshi-hook stop`,
  `env X=1 ${BIN_Q} codex stop --verbose`,
  `${NODE_Q} ${BIN_Q} codex some-future-event`,
  `${NODE_Q} ${BIN_Q} codex stop `,
  `${NODE_Q} ${BIN_Q} codex stop ; id`,
  `${NODE_Q} ${BIN_Q} codex permission-request ; id`,
  `${NODE_Q} ${BIN_Q} codex permission-request `,
  `${NODE_Q} ${BIN_Q} codex pre-tool-use extra`,
  `${NODE_Q} ${BIN_Q} codex permission-request --timeout-sec 35 ; id`,
  `${NODE_Q} ${BIN_Q} codex permission-request --timeout-sec 0`,
  `${NODE_Q} ${BIN_Q} codex permission-request --timeout-sec 99999`,
  `${NODE_Q} ${BIN_Q} codex permission-request --timeout-sec 3x`,
  `${Q('/other/node')} ${BIN_Q} codex stop`,
  `${Q('/other/node')} ${BIN_Q} codex permission-request`,
  `foo ${NODE_Q} ${BIN_Q} codex stop`,
];
function lookalikeFile(d) {
  const hooks = { PermissionRequest: [{ hooks: LOOKALIKES.map(c => ({ type: 'command', command: c })) }],
    PreToolUse: [{ hooks: LOOKALIKES.map(c => ({ type: 'command', command: c })) }],
    PostToolUse: [{ hooks: LOOKALIKES.map(c => ({ type: 'command', command: c })) }],
    Stop: [{ hooks: LOOKALIKES.map(c => ({ type: 'command', command: c })) }] };
  return fixture(d, JSON.stringify({ hooks }, null, 2) + '\n');
}
test('lookalike commands are never replaced nor removed', t => {
  const d = tmp(t); const p = lookalikeFile(d);
  const orig = JSON.parse(fs.readFileSync(p, 'utf8')).hooks;
  const inst = JSON.parse(plan(p).after).hooks;
  for (const ev of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.deepEqual(inst[ev][0], orig[ev][0], ev);
    assert.equal(inst[ev].length, 2, ev);
  }
  const rm = JSON.parse(plan(p, { remove: true }).after).hooks;
  assert.deepEqual(rm, orig);
  assert.equal(plan(p, { remove: true }).changed, false);
});
test('our legacy answered entry (any --timeout-sec) is recognized, migrated in place and removed', t => {
  const d = tmp(t);
  const mine = n => ({ type: 'command', command: `${NODE_Q} ${BIN_Q} codex permission-request --timeout-sec ${n}`, timeout: n });
  const stop = { type: 'command', command: `${NODE_Q} ${BIN_Q} codex stop`, timeout: 15 };
  const other = moshi('moshi-hook perm');
  const p = fixture(d, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [other, mine(3600), mine(1)] }], Stop: [{ hooks: [stop, other] }] } }, null, 2) + '\n');
  const got = JSON.parse(plan(p).after).hooks;
  assert.equal(got.PermissionRequest.length, 1);
  assert.deepEqual(got.PermissionRequest[0].hooks.map(h => h.command),
    ['moshi-hook perm', NOTICE_ENTRIES.PermissionRequest.command], 'duplicates of ours collapse to the one notice entry');
  assert.deepEqual(got.PreToolUse, [{ matcher: 'request_user_input', hooks: [NOTICE_ENTRIES.PreToolUse] }]);
  assert.deepEqual(got.PostToolUse, [{ hooks: [NOTICE_ENTRIES.PostToolUse] }]);
  const rm = JSON.parse(plan(p, { remove: true }).after).hooks;
  assert.deepEqual(rm, { PermissionRequest: [{ hooks: [other] }], Stop: [{ hooks: [other] }] });
});
test('the entries are fixed: no path, timeout or flag is ever built from a user value', () => {
  for (const ev of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.deepEqual(cx.CODEX_PROFILE.buildEntry(ev, 50, BIN, process.execPath), NOTICE_ENTRIES[ev]);
  }
  // a bad timeout is still refused at the plan boundary (the CLI flag stays a validated number)
  assert.equal(cx.CODEX_PROFILE.defaultTimeoutSec, 120, 'the default is the S5 wait the PermissionRequest entry carries');
  for (const bad of ['4; touch PWN', 4.5, '', NaN, 0, 3601, '035', null]) {
    const d = fs.mkdtempSync(path.join(tmpBase(), 'abito-instcodex-'));
    try {
      assert.throws(() => cx.planCodexHooks({ settingsPath: path.join(d, 'h.json'), timeoutSec: bad }), /timeout-sec/, String(bad));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

// ---- K2-08 T3 (S2, S4): the Windows command (Codex runs hooks with `cmd /C` on Windows, see Coucou agents.rs) ----
// cmd /C with a line that starts with a quote and is not ONE quoted program removes the first and the last quote and
// runs the rest (`cmd /?`). Node then splits its arguments the MSVCRT way. This emulates both so a path with spaces and
// non-ASCII letters can be checked on every OS; the win32-only test below runs the real cmd.exe.
function cmdSlashC(line) {
  assert.ok((line.match(/"/g) || []).length > 2, 'never the lone-quoted-program case: cmd must strip the outer pair');
  assert.equal(line[0], '"');
  const last = line.lastIndexOf('"');
  return line.slice(1, last) + line.slice(last + 1);
}
function msvcrtArgv(line) {
  const out = []; let cur = '', inQ = false, any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { assert.notEqual(line[i - 1], '\\', 'no backslash right before a quote'); inQ = !inQ; any = true; continue; }
    if (!inQ && '&|<>^()%!'.includes(c)) assert.fail(`cmd metacharacter ${c} outside quotes`);
    if (!inQ && (c === ' ' || c === '\t')) { if (any) out.push(cur); cur = ''; any = false; continue; }
    cur += c; any = true;
  }
  assert.equal(inQ, false, 'quotes balanced');
  if (any) out.push(cur);
  return out;
}
const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_BIN = 'C:\\Users\\Ana María\\AppData\\Local\\Programs\\Koda\\resources\\desktop-harness\\bin\\abito-hook.cjs';

test('Windows paths with spaces: every entry carries a cmd-style commandWindows that splits into the intended argv', t => {
  const d = tmp(t);
  const pl = plan(path.join(d, 'hooks.json'), { execPath: WIN_NODE, binPath: WIN_BIN });
  const got = JSON.parse(pl.after).hooks;
  const perm = got.PermissionRequest[0].hooks[0];
  assert.equal(perm.commandWindows, `""${WIN_NODE}" "${WIN_BIN}" codex permission-request --timeout-sec 120"`);
  assert.equal(perm.timeout, 120);
  assert.equal(perm.statusMessage, WAITING);
  for (const ev of Object.keys(SUBS)) {
    const h = got[ev][0].hooks[0];
    assert.deepEqual(h, entryOf(ev, WIN_NODE, WIN_BIN), ev);
    assert.deepEqual(msvcrtArgv(cmdSlashC(h.commandWindows)), [WIN_NODE, WIN_BIN, 'codex', ...SUBS[ev].split(' ')], ev);
  }
  // a plain node path (no spaces) works the same way: the outer pair is still what cmd strips
  const plain = cx.CODEX_PROFILE.buildEntry('PermissionRequest', 120, WIN_BIN, 'C:\\nodejs\\node.exe');
  assert.deepEqual(msvcrtArgv(cmdSlashC(plain.commandWindows)), ['C:\\nodejs\\node.exe', WIN_BIN, 'codex', 'permission-request', '--timeout-sec', '120']);
  // the Windows install is recognized as ours: idempotent and removable
  fs.writeFileSync(path.join(d, 'hooks.json'), pl.after);
  assert.equal(plan(path.join(d, 'hooks.json'), { execPath: WIN_NODE, binPath: WIN_BIN }).changed, false);
  assert.equal(JSON.parse(plan(path.join(d, 'hooks.json'), { execPath: WIN_NODE, binPath: WIN_BIN, remove: true }).after).hooks, undefined);
});

test('Windows paths: upgrading the notice-era install replaces all four Koda entries in place (they gain commandWindows); second run no-op; other tools kept', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  const old = sub => ({ type: 'command', command: `${q(WIN_NODE)} ${q(WIN_BIN)} codex ${sub}`, timeout: sub === 'stop' ? 15 : 5, statusMessage: 'Koda island' });
  const before = { hooks: {
    PermissionRequest: [{ hooks: [moshi('moshi-hook perm'), old('permission-request')] }],
    PreToolUse: [{ matcher: 'request_user_input', hooks: [old('pre-tool-use')] }],
    PostToolUse: [{ hooks: [old('post-tool-use')] }],
    Stop: [{ hooks: [old('stop'), moshi('moshi-hook stop')] }],
  } };
  fs.writeFileSync(p, JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
  const o = { execPath: WIN_NODE, binPath: WIN_BIN };
  const pl = plan(p, o);
  assert.deepEqual(pl.actions.map(a => [a.event, a.action]), [['PermissionRequest', 'replace'], ['PreToolUse', 'replace'], ['PostToolUse', 'replace'], ['Stop', 'replace']]);
  const got = JSON.parse(pl.after).hooks;
  const want = ev => entryOf(ev, WIN_NODE, WIN_BIN);
  assert.deepEqual(got.PermissionRequest, [{ hooks: [moshi('moshi-hook perm'), want('PermissionRequest')] }]);
  assert.deepEqual(got.PreToolUse, [{ matcher: 'request_user_input', hooks: [want('PreToolUse')] }]);
  assert.deepEqual(got.PostToolUse, [{ hooks: [want('PostToolUse')] }]);
  assert.deepEqual(got.Stop, [{ hooks: [want('Stop'), moshi('moshi-hook stop')] }]);
  fs.writeFileSync(p, pl.after);
  assert.equal(plan(p, o).changed, false, 'a second install run is a no-op');
});

test('Windows paths cmd would expand or split are refused (65); POSIX paths get no commandWindows', t => {
  const d = tmp(t); const p = path.join(d, 'hooks.json');
  for (const bad of ['C:\\a%PATH%\\node.exe', 'C:\\a&b\\node.exe', 'C:\\a^b\\node.exe', 'C:\\a|b\\node.exe', 'C:\\a<b\\node.exe', 'C:\\a>b\\node.exe', 'C:\\a"b\\node.exe']) {
    assert.throws(() => plan(p, { execPath: bad, binPath: WIN_BIN }), e => e.exitCode === 65, bad);
    assert.throws(() => plan(p, { execPath: WIN_NODE, binPath: bad }), e => e.exitCode === 65, bad);
  }
  const posix = cx.CODEX_PROFILE.buildEntry('PermissionRequest', 120, '/opt/koda/bin/abito-hook.cjs', '/usr/bin/node');
  assert.equal(posix.commandWindows, undefined);
  assert.equal(posix.command, "'/usr/bin/node' '/opt/koda/bin/abito-hook.cjs' codex permission-request --timeout-sec 120");
});

test('win32: the real cmd.exe /C runs commandWindows with a spaced, non-ASCII script path as one argument', { skip: process.platform !== 'win32' && 'cmd.exe exists only on Windows; the emulation above covers the quoting on every OS' }, t => {
  const d = tmp(t);
  const dir = path.join(d, 'Ana María', 'bin'); fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'abito hook.cjs');
  fs.writeFileSync(stub, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
  const e = cx.CODEX_PROFILE.buildEntry('PermissionRequest', 120, stub, process.execPath);
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/C', e.commandWindows], { windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [stub, 'codex', 'permission-request', '--timeout-sec', '120']);
});

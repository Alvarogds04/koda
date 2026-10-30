'use strict';
const { tmpBase, assertMode, unixOnly } = require('./platform-env.cjs');
// Temp dirs only (mkdtemp under tmpBase()); the real ~/.codex is never touched.
// S4/T2 (human L3, option A): the installed entries are NOTICE-ONLY — PermissionRequest (notice), PreToolUse with matcher
// `request_user_input` (plan-mode questions, notice) and Stop (finished notice + the clearing frame). No entry asks the
// island for a decision any more, so no `--timeout-sec` rides the command: the notice is fire-and-forget and bounded.
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
const NOTICE_ENTRIES = {
  PermissionRequest: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex permission-request`, timeout: 5, statusMessage: 'Koda island' },
  PreToolUse: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex pre-tool-use`, timeout: 5, statusMessage: 'Koda island' },
  PostToolUse: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex post-tool-use`, timeout: 5, statusMessage: 'Koda island' },
  Stop: { type: 'command', command: `${q(process.execPath)} ${q(BIN)} codex stop`, timeout: 15, statusMessage: 'Koda island' },
};

test('install adds exactly our three notice groups; outside hooks byte-exact; third-party semantically exact', t => {
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

test('no installed entry can buy a question from the island: no --timeout-sec, no decision surface', t => {
  const d = tmp(t); const p = fixture(d);
  const after = JSON.parse(plan(p).after);
  for (const ev of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const h = after.hooks[ev].at(-1).hooks[0];
    assert.doesNotMatch(h.command, /--timeout-sec/, ev);
    assert.ok(h.timeout <= 15, `${ev}: a notice is bounded (${h.timeout}s)`);
  }
});

test('idempotent re-install; a --timeout-sec change is inert now; remove restores the original bytes', t => {
  const d = tmp(t); const p = fixture(d);
  const one = plan(p); fs.writeFileSync(p, one.after);
  assert.equal(plan(p).changed, false, 'second run is a no-op');
  const t50 = plan(p, { timeoutSec: 50 });
  assert.equal(t50.changed, false, 'the Codex notice never waits, so the budget changes nothing');
  const rm = plan(p, { remove: true });
  assert.deepEqual(JSON.parse(rm.after), JSON.parse(FIX));
  assert.ok(rm.after.startsWith(FIX.slice(0, FIX.indexOf('"hooks"'))) && rm.after.endsWith(FIX.slice(FIX.indexOf('  "tail"'))));
});

test('migration: a legacy answered-install is replaced by the notice entries, foreign hooks untouched, second run no-op', t => {
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

test('preview names the target, the /hooks trust review and the notice-only rule; never the bypass flag', async t => {
  const d = tmp(t); const p = fixture(d); const r = io();
  assert.equal(await cx.runInstallCodex(['codex', '--settings', p], r.opts), 0);
  assert.ok(r.out.includes(p));
  assert.ok(r.out.includes('/hooks'));
  assert.match(r.out, /untrusted|trust/i);
  assert.match(r.out, /aviso|notice/i);
  assert.match(r.out, /terminal/);
  assert.ok(!/dangerously/i.test(r.out));
  assert.ok(!/allow/i.test(r.out), 'the island never answers for Codex any more');
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
test('the notice entries are fixed: no path, timeout or flag is ever built from a user value', () => {
  for (const ev of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.deepEqual(cx.CODEX_PROFILE.buildEntry(ev, 50, BIN, process.execPath), NOTICE_ENTRIES[ev]);
  }
  // a bad timeout is still refused at the plan boundary (the CLI flag stays a validated number)
  assert.equal(cx.CODEX_PROFILE.defaultTimeoutSec, 5, 'the default is the notice bound, not a question budget');
  for (const bad of ['4; touch PWN', 4.5, '', NaN, 0, 3601, '035', null]) {
    const d = fs.mkdtempSync(path.join(tmpBase(), 'abito-instcodex-'));
    try {
      assert.throws(() => cx.planCodexHooks({ settingsPath: path.join(d, 'h.json'), timeoutSec: bad }), /timeout-sec/, String(bad));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

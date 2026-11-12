'use strict';
// K2-08 T2 (S3): a Codex permission request that Codex's own automatic reviewer handles never reaches the island. Rule
// adapted from Coucou (docs/INTEGRATIONS.md §8): only a rollout under `$CODEX_HOME/sessions`, read with bounded reads,
// whose first record is the hook's session and whose `turn_context` for the EXACT `turn_id` names `auto_review` or
// `strict_auto_review` (or Codex's internal Guardian session) skips the card; the hook then prints nothing (exit 0).
// Anything unknown, unreadable, missing, oversized or malformed shows the card as before: the hook never approves alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { offlineEnv, tmpBase } = require('./platform-env.cjs');
const { handleCodexHook: raw_handleCodexHook, ALLOW, DENY } = require('../src/codex.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const handleCodexHook = viaPipe(raw_handleCodexHook);

const cwd = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'codex-rollouts');
const DAY = path.join(FIX, 'sessions', '2026', '11', '11');
const rollout = name => path.join(DAY, `rollout-${name}.jsonl`);
const OUTSIDE = path.join(FIX, 'outside', 'rollout-auto-review.jsonl');
const AUTO = { session_id: 'sess-auto', turn_id: 'turn-auto', transcript_path: rollout('auto-review') };
const permission = over => JSON.stringify({ session_id: 'sess-1', cwd, model: 'm', permission_mode: 'default', turn_id: 't1',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, ...over });
const silent = r => { assert.equal(r.exitCode, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); };

// Every file the hook opens while it runs (to prove an untrusted transcript is never read).
function openSpy(t) {
  const opened = [];
  const wrap = name => {
    const real = fs[name];
    t.mock.method(fs, name, function (p, ...rest) {
      if (typeof p === 'string') opened.push(path.resolve(p));
      return real.call(fs, p, ...rest);
    });
  };
  for (const name of ['openSync', 'readFileSync', 'createReadStream']) wrap(name);
  return opened;
}
// A stub island that answers «Aprobar una vez» at once and counts the cards it was asked to show.
function counting() {
  const seen = { asked: 0, other: 0 };
  const factory = () => ({ ask: async () => { seen.asked++; return { status: 'answered', answer: { type: 'option', value: 'allow' } }; },
    attention: async () => { seen.other++; return { status: 'sent' }; }, notify: async () => { seen.other++; },
    clearAttention: async () => { seen.other++; } });
  return { seen, factory };
}
const run = (over, codexHome = FIX, clientFactory) => handleCodexHook({ event: 'permission-request', input: permission(over),
  env: { ...offlineEnv('nonexistent-abito-test'), CODEX_HOME: codexHome }, argv: [], clientFactory });
// The automatic reviewer handles it: nothing is sent to the island and nothing is printed.
async function assertSkipped(over, codexHome = FIX) {
  const { seen, factory } = counting();
  const r = await run(over, codexHome, factory);
  silent(r);
  assert.deepEqual(seen, { asked: 0, other: 0 }, JSON.stringify(over));
}
// Anything else: the card is sent exactly as before (the stub's «Aprobar una vez» comes back as allow).
async function assertShown(over, codexHome = FIX) {
  const { seen, factory } = counting();
  const r = await run(over, codexHome, factory);
  assert.equal(seen.asked, 1, `the card must be shown: ${JSON.stringify(over)}`);
  assert.equal(r.stdout, ALLOW);
  assert.equal(r.exitCode, 0);
}
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(tmpBase(), 'koda-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'sessions'));
  return home;
}
const line = row => JSON.stringify(row) + '\n';
const metaRow = id => line({ type: 'session_meta', payload: { id, cwd: '/work', source: 'cli', thread_source: 'user' } });
const ctxRow = (turn_id, approvals_reviewer) => line({ type: 'turn_context', payload: { turn_id, approval_policy: 'on-request', approvals_reviewer } });

test('S3: reviewer auto_review for the request\'s turn → no card, nothing printed, exit 0', async () => {
  await assertSkipped(AUTO);
  await assertSkipped({ ...AUTO, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' } });
});

test('S3: reviewer strict_auto_review → no card, nothing printed', async () => {
  await assertSkipped({ session_id: 'sess-strict', turn_id: 'turn-strict', transcript_path: rollout('strict-auto-review') });
});

test('S3: Codex\'s internal Guardian session (inherited session id) → no card, nothing printed', async () => {
  await assertSkipped({ session_id: 'sess-guardian', turn_id: 'any-turn', transcript_path: rollout('guardian') });
  // Guardian proof needs the inherited session id: another session cannot borrow it.
  await assertShown({ session_id: 'sess-other', turn_id: 'any-turn', transcript_path: rollout('guardian') });
});

test('S3: reviewer user → the card reaches the island and «Aprobar» / «Rechazar» still decide', async t => {
  for (const [value, line_] of [['allow', ALLOW], ['deny', DENY]]) {
    for (const over of [{ session_id: 'sess-user', turn_id: 'turn-user', transcript_path: rollout('user-review') },
      { ...AUTO, turn_id: 'turn-human' }]) {
      const rcv = await fakeReceiver(t, { questions: true });
      const answered = rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
        sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
      const r = await handleCodexHook({ event: 'permission-request', input: permission(over),
        env: { ABITO_DESKTOP_SOCKET: rcv.endpoint, ABITO_SOCKET_DIR: rcv.runtime, CODEX_HOME: FIX }, argv: [] });
      await answered;
      assert.equal(r.stdout, line_, JSON.stringify(over));
      assert.equal(rcv.frames.filter(f => f.type === 'question').length, 1);
      assert.doesNotMatch(rcv.rawFrames.join(''), /rollout-|turn-|codex-rollouts/, 'the transcript never travels');
    }
  }
});

test('S3: the turn_id must match EXACTLY; another turn, no turn or a lookalike shows the card', async () => {
  for (const turn_id of ['turn-other', 'TURN-AUTO', 'turn-aut', 'turn-auto ', ' turn-auto', '', undefined, 5, null]) {
    await assertShown({ ...AUTO, turn_id });
  }
});

test('S3: the hook\'s session must be the rollout\'s first record; another session shows the card', async () => {
  for (const session_id of ['sess-other', 'SESS-AUTO', '', undefined]) await assertShown({ ...AUTO, session_id });
});

test('S3: a transcript outside $CODEX_HOME/sessions is never read and shows the card', async t => {
  const opened = openSpy(t);
  await assertShown({ ...AUTO, transcript_path: OUTSIDE });
  // `..` escape written inside the sessions prefix.
  await assertShown({ ...AUTO, transcript_path: `${path.join(FIX, 'sessions')}${path.sep}..${path.sep}outside${path.sep}rollout-auto-review.jsonl` });
  await assertShown({ ...AUTO, transcript_path: path.join(DAY, '..', '..', '..', '..', 'outside', 'rollout-auto-review.jsonl') });
  // CODEX_HOME pointing elsewhere: the fixture rollout is no longer under its sessions directory.
  await assertShown(AUTO, tempHome(t));
  // A relative path is never resolved against the hook's cwd.
  await assertShown({ ...AUTO, transcript_path: path.relative(process.cwd(), rollout('auto-review')) });
  assert.equal(opened.filter(p => p.includes(`${path.sep}outside${path.sep}`) || p === rollout('auto-review')).length, 0,
    `never read: ${opened.join(', ')}`);
  // The spy is live: the trusted rollout IS opened.
  await assertSkipped(AUTO);
  assert.ok(opened.includes(rollout('auto-review')));
});

test('S3: a symlink escaping $CODEX_HOME/sessions (file or directory) is never read and shows the card', async t => {
  const home = tempHome(t);
  const fileLink = path.join(home, 'sessions', 'rollout-link.jsonl');
  const dirLink = path.join(home, 'sessions', 'linked-dir');
  try {
    fs.symlinkSync(OUTSIDE, fileLink, 'file');
    fs.symlinkSync(path.dirname(OUTSIDE), dirLink, 'dir');
  } catch (error) {
    t.skip(`symlinks unavailable here: ${error.code}`);
    return;
  }
  const opened = openSpy(t);
  await assertShown({ ...AUTO, transcript_path: fileLink }, home);
  await assertShown({ ...AUTO, transcript_path: path.join(dirLink, 'rollout-auto-review.jsonl') }, home);
  assert.equal(opened.filter(p => p.startsWith(home) || p.includes(`${path.sep}outside${path.sep}`)).length, 0, opened.join(', '));
});

test('S3: missing, malformed, forged, conflicting or unknown rollouts show the card', async () => {
  await assertShown({ ...AUTO, transcript_path: rollout('does-not-exist') });
  await assertShown({ ...AUTO, transcript_path: DAY }); // a directory, not a file
  await assertShown({ session_id: 'sess-malformed', turn_id: 'turn-auto', transcript_path: rollout('malformed-first') });
  await assertShown({ session_id: 'sess-forged', turn_id: 'turn-auto', transcript_path: rollout('forged-meta') });
  await assertShown({ session_id: 'sess-conflict', turn_id: 'turn-auto', transcript_path: rollout('conflicting') });
  await assertShown({ session_id: 'sess-unknown', turn_id: 'turn-auto', transcript_path: rollout('unknown-reviewer') });
  await assertShown({ session_id: 'sess-unknown', turn_id: 'turn-none', transcript_path: rollout('unknown-reviewer') });
  await assertShown({ session_id: 'sess-auto', turn_id: 'turn-auto', transcript_path: rollout('garbage') });
});

test('S3: no transcript_path (absent, empty or not a string) shows the card', async () => {
  for (const transcript_path of [undefined, '', 5, null, ['x'], { p: 'x' }]) await assertShown({ ...AUTO, transcript_path });
});

test('S3: an oversized rollout is read only in bounded segments; a turn beyond them shows the card', async t => {
  const home = tempHome(t);
  const big = path.join(home, 'sessions', 'rollout-big.jsonl');
  const PAD = 10 * 1024 * 1024; // more than the header and tail windows together
  // The auto_review context sits before 10 MiB of padding: outside the bounded tail, so unknown → card.
  fs.writeFileSync(big, metaRow('sess-big') + ctxRow('turn-early', 'auto_review'));
  fs.appendFileSync(big, Buffer.alloc(PAD, 0x20));
  fs.appendFileSync(big, '\n' + ctxRow('turn-late', 'auto_review'));
  await assertShown({ session_id: 'sess-big', turn_id: 'turn-early', transcript_path: big }, home);
  // The latest turn sits in the tail: still recognised in a large rollout, reading at most header + tail bytes.
  let bytes = 0;
  const realReadSync = fs.readSync;
  t.mock.method(fs, 'readSync', function (...args) { const n = realReadSync.apply(fs, args); bytes += n; return n; });
  await assertSkipped({ session_id: 'sess-big', turn_id: 'turn-late', transcript_path: big }, home);
  const { HEADER_MAX_BYTES, TAIL_MAX_BYTES } = require('../src/codex-reviewer.cjs');
  assert.ok(fs.statSync(big).size > HEADER_MAX_BYTES + TAIL_MAX_BYTES, 'the fixture is larger than both windows');
  assert.ok(bytes > 0 && bytes <= HEADER_MAX_BYTES + TAIL_MAX_BYTES, `bounded read: ${bytes} bytes of ${fs.statSync(big).size}`);
  // A first record larger than the header window is not a complete session_meta: card.
  const fat = path.join(home, 'sessions', 'rollout-fat-meta.jsonl');
  fs.writeFileSync(fat, line({ type: 'session_meta', payload: { id: 'sess-fat', pad: 'x'.repeat(2 * 1024 * 1024) } }) + ctxRow('turn-auto', 'auto_review'));
  await assertShown({ session_id: 'sess-fat', turn_id: 'turn-auto', transcript_path: fat }, home);
  // Too many records in the tail window: not scanned, card.
  const many = path.join(home, 'sessions', 'rollout-many.jsonl');
  fs.writeFileSync(many, metaRow('sess-many') + '{}\n'.repeat(120000) + ctxRow('turn-auto', 'auto_review'));
  await assertShown({ session_id: 'sess-many', turn_id: 'turn-auto', transcript_path: many }, home);
});

test('S3: MCP tools never reach the island, even in an auto-reviewed turn (T1 unchanged)', async () => {
  await assertSkipped({ ...AUTO, tool_name: 'mcp__srv__ping' });
  await assertSkipped({ ...AUTO, turn_id: 'turn-human', tool_name: 'mcp__srv__ping' });
});

test('codexAutoReviewed: pure classifier — true only for proven automatic review, false for anything else', () => {
  const { codexAutoReviewed } = require('../src/codex-reviewer.cjs');
  const base = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', ...AUTO };
  const env = { CODEX_HOME: FIX };
  assert.equal(codexAutoReviewed(base, env), true);
  assert.equal(codexAutoReviewed({ ...base, tool_name: 'mcp__srv__ping' }, env), false, 'MCP may override the reviewer per call');
  for (const tool_name of [undefined, '', 5]) assert.equal(codexAutoReviewed({ ...base, tool_name }, env), false);
  assert.equal(codexAutoReviewed({ ...base, hook_event_name: 'PreToolUse' }, env), false);
  for (const bad of [null, undefined, 'x', [], 5]) assert.equal(codexAutoReviewed(bad, env), false);
  for (const home of [undefined, '', 'relative/home', path.join(FIX, 'missing-home'), 5]) {
    assert.equal(codexAutoReviewed(base, { CODEX_HOME: home, HOME: '/nonexistent-koda-home', USERPROFILE: '/nonexistent-koda-home' }), false, String(home));
  }
  assert.equal(codexAutoReviewed(base, null), false);
});

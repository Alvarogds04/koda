'use strict';
/* K3-06 T1 (S3, S4): run-node-checks.cjs runs up to N checks at once with `--jobs N`, and the rest of the contract does not
   move: the same checks give the same results and the same exit code as `--jobs 1` (the default, unchanged for CI), a
   failing check still yields exit code = the number of failures and its captured output is printed once, inside its own
   block (never interleaved with another check's lines), and `--jobs` is validated like `--shard` (usage error, exit 2).
   The fake checks live in a temp dir and are passed as absolute paths, so nothing is written into the repository and the
   default selection is never touched (which would recurse into this very check).
   Group B is a rendezvous: every check waits until all four have started, so they can only pass when the pool really runs
   them at once; run one at a time they would time out and fail.
   K3-06 T3 (S6): `--no-browser` drops the checks that drive a real browser (a platform-specific one is kept) and
   `--balanced` splits the selection over the shards by MEASURED time (test-node/check-timings.json, greedy longest first),
   so the CI shards finish together; `--shard i/N` WITHOUT `--balanced` still splits positionally, exactly as before, and
   the two env aliases the CI job uses reach the same selections as the flags.
   Run: node test-node/run-node-checks-check.cjs */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crate = path.resolve(__dirname, '..');
const repo = path.resolve(crate, '..', '..');
const runner = path.join(repo, 'run-node-checks.cjs');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-06-node-checks-'));
const write = (name, source) => { const file = path.join(tmp, name); fs.writeFileSync(file, source); return file; };
// RUN_NODE_CHECKS_JOBS / NO_BROWSER / BALANCED are cleared so an ambient value cannot stand in for the flag under test
// (the CI job sets the last two). `extra` re-adds them for the env-alias cases only.
const run = (args, ms = 30000, extra = {}) => spawnSync(process.execPath, [runner, ...args], {
  cwd: crate, encoding: 'utf8', timeout: ms,
  env: { ...process.env, RUN_NODE_CHECKS_JOBS: '', RUN_NODE_CHECKS_NO_BROWSER: '', RUN_NODE_CHECKS_BALANCED: '', ...extra },
});
/** The `--list` selection as an array of lines. */
const listed = (args, extra = {}) => run([...args, '--list'], 30000, extra).stdout.trim().split(/\r?\n/);
/** `ok   <file> (1.2s)` / `FAIL(1) <file> (0.3s)` → ['ok <file>', 'FAIL <file>'] in the order they were printed. */
const outcomes = (stdout) => stdout.split(/\r?\n/)
  .map((l) => /^(ok|FAIL(?:\(\d+\))?)\s+(\S+) /.exec(l))
  .filter(Boolean)
  .map((m) => `${m[1].startsWith('ok') ? 'ok' : 'FAIL'} ${m[2]}`);

try {
  /* ---- Group A: three ordinary check-like files, one of them failing ---- */
  const slowOk = `setTimeout(() => { console.log('a-ok: fine'); process.exit(0); }, 120);\n`;
  const fail = [
    `console.log('boom-FAIL-marker: this check failed');`,
    // filler so the marker is not repeated by the runner's «--- last lines ---» tail
    `for (let i = 0; i < 20; i += 1) console.log('filler line ' + i);`,
    `setTimeout(() => process.exit(1), 120);`,
    '',
  ].join('\n');
  const a = write('a-ok-check.cjs', slowOk);
  const b = write('b-fail-check.cjs', fail);
  const c = write('c-ok-check.cjs', `setTimeout(() => { console.log('c-ok: fine'); process.exit(0); }, 120);\n`);
  const groupA = [a, b, c];

  const serial = run(['--jobs', '1', ...groupA]);
  const parallel = run(['--jobs', '4', ...groupA]);
  const dflt = run([...groupA]);

  test('--jobs 4 gives the same outcomes and the same exit code as --jobs 1', () => {
    assert.equal(serial.error, undefined);
    assert.equal(parallel.error, undefined);
    assert.equal(serial.status, 1, `exit code = failures (--jobs 1): ${serial.stdout}${serial.stderr}`);
    assert.equal(parallel.status, 1, `exit code = failures (--jobs 4): ${parallel.stdout}${parallel.stderr}`);
    assert.deepEqual([...outcomes(parallel.stdout)].sort(), [...outcomes(serial.stdout)].sort());
    assert.deepEqual(outcomes(serial.stdout), [`ok ${a}`, `FAIL ${b}`, `ok ${c}`], 'the selected files are all run');
  });
  test('the default (no --jobs) is --jobs 1: one at a time, in argument order', () => {
    assert.equal(dflt.status, 1, dflt.stdout + dflt.stderr);
    assert.deepEqual(outcomes(dflt.stdout), [`ok ${a}`, `FAIL ${b}`, `ok ${c}`], 'unchanged order for the default');
  });
  test('a failing check yields exit code 1 and its output is printed once', () => {
    for (const [name, r] of [['--jobs 1', serial], ['--jobs 4', parallel], ['default', dflt]]) {
      assert.equal(r.status, 1, name);
      assert.equal(r.stdout.split('boom-FAIL-marker').length - 1, 1, `${name}: the failure output is printed exactly once`);
      assert.equal(r.stdout.split('--- last lines ---').length - 1, 1, `${name}: one failure block`);
    }
  });
  test('the failure block is never interleaved with another check\'s lines', () => {
    const lines = parallel.stdout.split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith('FAIL('));
    assert.ok(at >= 0, 'the failure line is there');
    assert.match(lines[at], /^FAIL\(1\) /);
    let end = at + 1;
    while (end < lines.length && !/^(ok {3}|FAIL\(|node-checks: )/.test(lines[end])) end += 1;
    const block = lines.slice(at + 1, end);
    assert.ok(block.length > 0, 'the failure block carries the captured output');
    for (const l of block) assert.ok(l === '' || l.startsWith('    '), `only the failure block's own lines: ${JSON.stringify(l)}`);
    assert.ok(block.some((l) => l.includes('boom-FAIL-marker')), 'the marker sits inside that block');
  });
  test('the summary line is printed once, at the end, and counts the failures', () => {
    for (const r of [serial, parallel, dflt]) {
      const lines = r.stdout.split(/\r?\n/).filter((l) => l !== '');
      assert.equal(lines.filter((l) => l.startsWith('node-checks: ')).length, 1, 'one summary line');
      assert.equal(lines[lines.length - 1], 'node-checks: 3 run, 1 failed', 'the summary closes the run');
    }
  });

  /* ---- Group B: a rendezvous only a real pool can satisfy ---- */
  const BARRIER = 4;
  const started = (i) => path.join(tmp, `started-${i}`);
  const groupB = Array.from({ length: BARRIER }, (_, i) => write(`barrier-${i}-check.cjs`, `
    const fs = require('node:fs');
    const path = require('node:path');
    const mine = ${JSON.stringify(started(i))};
    fs.writeFileSync(mine, '');
    const deadline = Date.now() + 1500;
    (function wait() {
      const all = fs.readdirSync(${JSON.stringify(tmp)}).filter((f) => f.startsWith('started-'));
      if (all.length === ${BARRIER}) return process.exit(0);
      if (Date.now() > deadline) { console.log('barrier never filled (only ' + all.length + ' started)'); return process.exit(3); }
      setTimeout(wait, 20);
    })();
  `));
  test('--jobs 4 really runs four checks at once (they all start before any of them ends)', () => {
    for (let i = 0; i < BARRIER; i += 1) fs.rmSync(started(i), { force: true });
    const t0 = Date.now();
    const r = run(['--jobs', '4', ...groupB], 60000);
    const secs = (Date.now() - t0) / 1000;
    assert.equal(r.status, 0, `every barrier check met the others (${r.stdout}${r.stderr})`);
    assert.deepEqual(outcomes(r.stdout).map((o) => o.split(' ')[0]), ['ok', 'ok', 'ok', 'ok']);
    assert.ok(secs < 10, `the rendezvous did not have to wait: ${secs}s`);
  });

  /* ---- validation, like --shard ---- */
  test('--jobs 0, --jobs abc and a missing value are usage errors (exit 2)', () => {
    for (const args of [['--jobs', '0', ...groupA], ['--jobs', 'abc', ...groupA], ['--jobs', ...groupA]]) {
      const r = run(args);
      assert.equal(r.status, 2, `${args.join(' ')} → exit 2 (${r.stdout}${r.stderr})`);
      assert.match(r.stderr, /--jobs expects an integer >= 1/, 'the usage error names --jobs');
    }
  });

  /* ---- Group C: --no-browser (K3-06 T3, S6: the human decided the browser checks run only on Linux) ---- */
  const plain = write('plain-fake-check.cjs', `setTimeout(() => { console.log('plain: fine'); process.exit(0); }, 60);\n`);
  const browserOnly = write('drives-chromium-check.cjs', `// drives a real chromium through playwright\nsetTimeout(() => { console.log('browser: fine'); process.exit(0); }, 60);\n`);
  const platformBrowser = write('per-platform-check.cjs', `// a chromium check whose verdict is per platform\nconst onWin = process.platform === 'win32';\nsetTimeout(() => { console.log('platform: ' + onWin); process.exit(0); }, 60);\n`);
  const groupC = [plain, browserOnly, platformBrowser];

  test('--no-browser skips the browser check, and keeps the plain one and the platform-specific browser check', () => {
    const r = run(['--no-browser', ...groupC]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(outcomes(r.stdout), [`ok ${plain}`, `ok ${platformBrowser}`], 'the browser check is not even started');
    assert.equal(r.stdout.split('drives-chromium-check.cjs').length - 1, 0, 'no line at all for the skipped check');
    assert.match(r.stdout, /node-checks: 2 run, 0 failed/, 'the summary counts what really ran');
  });
  test('--no-browser shows up in --list, and without it nothing is dropped', () => {
    assert.deepEqual(listed(['--no-browser', ...groupC]), [plain, platformBrowser]);
    assert.deepEqual(listed(groupC), groupC, 'the browser check is still selected without the flag');
  });
  test('RUN_NODE_CHECKS_NO_BROWSER is the same selection as --no-browser (the CI job cannot put flags on its frozen `--shard i/N` line)', () => {
    assert.deepEqual(listed(groupC, { RUN_NODE_CHECKS_NO_BROWSER: '1' }), listed(['--no-browser', ...groupC]));
    assert.deepEqual(listed([], { RUN_NODE_CHECKS_NO_BROWSER: '1' }), listed(['--no-browser']), 'same on the real default set');
    assert.deepEqual(listed([], { RUN_NODE_CHECKS_NO_BROWSER: '0' }), listed([]), "'0' is off");
  });
  test('the runner does not pass its own selection env on to the checks it spawns', () => {
    // no-node-smoke-check calls the runner itself to prove the shards partition the DEFAULT set: a check that inherits
    // RUN_NODE_CHECKS_NO_BROWSER would see a different set and its proof would be about the wrong list.
    const countFile = path.join(tmp, 'nested-count.txt');
    const nested = write('nested-default-check.cjs', `
      const { spawnSync } = require('node:child_process');
      const fs = require('node:fs');
      const r = spawnSync(process.execPath, [${JSON.stringify(runner)}, '--list'], { encoding: 'utf8' });
      fs.writeFileSync(${JSON.stringify(countFile)}, String(r.stdout.trim().split(/\\r?\\n/).length));
      process.exit(r.status === 0 ? 0 : 1);
    `);
    fs.rmSync(countFile, { force: true });
    const r = run(['--no-browser', nested], 60000, { RUN_NODE_CHECKS_NO_BROWSER: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const nestedCount = Number(fs.readFileSync(countFile, 'utf8'));
    assert.equal(nestedCount, listed([]).length, 'the nested run sees the whole default set, not the filtered one');
  });

  /* ---- Group D: --balanced (K3-06 T3, S6: shards by measured time) ---- */
  const table = JSON.parse(fs.readFileSync(path.join(crate, 'test-node', 'check-timings.json'), 'utf8'));
  const secs = (file) => (Number.isFinite(table[file]) && table[file] > 0 ? table[file] : 5); // same default as the runner
  const shardOf = (n, i, extra = {}) => listed(['--balanced', '--shard', `${i}/${n}`], extra);

  test('--shard i/N without --balanced keeps the positional split, byte for byte', () => {
    const all = listed([]);
    for (const [i, n] of [[1, 3], [2, 3], [1, 6]]) {
      assert.deepEqual(listed(['--shard', `${i}/${n}`]), all.filter((_, idx) => idx % n === i - 1), `shard ${i}/${n} unchanged`);
    }
  });
  test('--balanced covers every selected check exactly once across i = 1..6, and is deterministic', () => {
    const all = listed([]);
    const first = [];
    for (let i = 1; i <= 6; i += 1) {
      const shard = shardOf(6, i);
      assert.ok(shard.length > 0, `shard ${i}/6 is not empty`);
      first.push(shard);
    }
    const seen = first.flat();
    assert.deepEqual([...seen].sort(), [...all].sort(), 'the 6 shards partition the default set exactly once');
    assert.equal(new Set(seen).size, seen.length, 'no check lands in two shards');
    assert.deepEqual(shardOf(6, 3), first[2], 'the same input gives the same shard (greedy is deterministic)');
    assert.deepEqual(shardOf(2, 1), shardOf(2, 1), 'twice');
  });
  test('--balanced puts the measured time of the real table within 15% of the ideal for N = 6', () => {
    const total = listed([]).reduce((sum, f) => sum + secs(f), 0);
    const sums = Array.from({ length: 6 }, (_, k) => shardOf(6, k + 1).reduce((sum, f) => sum + secs(f), 0));
    const max = Math.max(...sums);
    const ideal = total / 6;
    assert.ok(max <= 1.15 * ideal, `the slowest shard is ${max}s against an ideal of ${ideal.toFixed(0)}s (shards ${sums.join(', ')})`);
    assert.equal(sums.reduce((a, b) => a + b, 0), total, 'the shards add up to the whole table');
  });
  test('--balanced uses the 5 s default for a check the table does not know, and still partitions', () => {
    // the temp checks are not in check-timings.json: with every entry at the default the split is still exact and stable.
    const many = Array.from({ length: 7 }, (_, i) => write(`balance-${i}-check.cjs`, `process.exit(0);\n`));
    const seen = [];
    for (let i = 1; i <= 3; i += 1) seen.push(...listed(['--balanced', '--shard', `${i}/3`, ...many]));
    assert.deepEqual([...seen].sort(), [...many].sort(), 'every unknown check lands in exactly one shard');
  });
  test('RUN_NODE_CHECKS_BALANCED is the same split as --balanced', () => {
    assert.deepEqual(listed(['--shard', '2/6'], { RUN_NODE_CHECKS_BALANCED: '1' }), listed(['--balanced', '--shard', '2/6']));
  });
  test('--balanced without --shard is a usage error (exit 2)', () => {
    const r = run(['--balanced', ...groupA]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--balanced needs --shard/);
  });
  test('--balanced finds a check in the timings table when it is named with backslashes (the Windows form of the path)', () => {
    // On Windows path.join gives `test-node\\x.cjs` while the table is keyed `test-node/x.cjs`. Without normalising, every check costs
    // the 5 s default and the heavy one shares its shard with light ones; with it, the heavy check sits alone against the lights.
    const entries = Object.entries(table).filter(([f]) => !f.includes('run-node-checks-check'));
    const heavy = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const lights = entries.filter(([, s]) => s <= 1).map(([f]) => f).slice(0, 8);
    assert.equal(lights.length, 8, 'the table has at least eight 1 s checks');
    const named = [heavy.replace(/\//g, '\\'), ...lights];
    const shards = [1, 2].map((i) => listed(['--balanced', '--shard', `${i}/2`, ...named]));
    const withHeavy = shards.find((s) => s.some((f) => f.replace(/\\/g, '/') === heavy));
    assert.ok(withHeavy, 'the heavy check is in one of the shards');
    assert.equal(withHeavy.length, 1, `the heavy check is alone in its shard (got ${withHeavy.join(', ')})`);
    assert.equal(shards.flat().length, 9, 'the two shards still cover every named check exactly once');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`run-node-checks-check: ${passed} passed`);

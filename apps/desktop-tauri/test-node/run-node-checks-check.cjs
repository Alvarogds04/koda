'use strict';
/* K3-06 T1 (S3, S4): run-node-checks.cjs runs up to N checks at once with `--jobs N`, and the rest of the contract does not
   move: the same checks give the same results and the same exit code as `--jobs 1` (the default, unchanged for CI), a
   failing check still yields exit code = the number of failures and its captured output is printed once, inside its own
   block (never interleaved with another check's lines), and `--jobs` is validated like `--shard` (usage error, exit 2).
   The fake checks live in a temp dir and are passed as absolute paths, so nothing is written into the repository and the
   default selection is never touched (which would recurse into this very check).
   Group B is a rendezvous: every check waits until all four have started, so they can only pass when the pool really runs
   them at once; run one at a time they would time out and fail.
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
// RUN_NODE_CHECKS_JOBS is cleared so an ambient value cannot stand in for the flag under test.
const run = (args, ms = 30000) => spawnSync(process.execPath, [runner, ...args], {
  cwd: crate, encoding: 'utf8', timeout: ms, env: { ...process.env, RUN_NODE_CHECKS_JOBS: '' },
});
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`run-node-checks-check: ${passed} passed`);

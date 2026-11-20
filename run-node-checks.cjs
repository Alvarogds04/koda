#!/usr/bin/env node
'use strict';
// Cross-platform runner for apps/desktop-tauri/test-node/*-check.cjs (K2-01): the same checks on Linux, macOS and Windows.
// Each check runs in its own process with a wall-clock cap and a V8 heap cap; on timeout its whole process tree is killed
// (process group on Unix, taskkill /T on Windows). run-node-checks.sh stays as the Linux-local runner with a memory cap.
// Usage: node run-node-checks.cjs [--shard <i>/<N> [--balanced]] [--no-browser] [--jobs <N>] [--list [--caps]] [check.cjs ...]
// (paths relative to apps/desktop-tauri; default: every *-check.cjs except producer-check.cjs, which is not a test). `--shard i/N`
// keeps every N-th file of the sorted list starting at the i-th (1-based), so N shard jobs run the set in parallel and together
// cover it exactly once. `--jobs N` runs N checks at once (default 1 = one at a time, in the selected order, exactly as before;
// RUN_NODE_CHECKS_JOBS sets that default for a shell). Each check keeps its own process, wall-clock cap and process-tree kill.
// `--list` prints the selected files and exits; with `--caps` each line is `<file>\t<cap seconds>`. Exit code = number of failures.
// K3-06 (S6, human decision of 20-nov-2026): `--no-browser` drops the checks that drive a real browser (source mentions
// chromium or playwright) EXCEPT the platform-specific ones (source mentions process.platform, win32 or darwin), because CI now
// runs the browser checks on Linux only; it filters the selection BEFORE the shard split, so the shards still partition what is
// left exactly once. `--balanced` (needs `--shard`) replaces the positional split with a greedy longest-first one over the
// measured per-check seconds in test-node/check-timings.json (what `--jobs 1` printed on 32 Linux cores), so the CI shards end
// together; a check missing from that table costs a default 5 s. `--shard i/N` without `--balanced` is unchanged byte for byte.
// Both also read RUN_NODE_CHECKS_NO_BROWSER / RUN_NODE_CHECKS_BALANCED ('1' on), because the island-checks job must keep its
// literal `node run-node-checks.cjs --shard <i>/N` command line (no-node-smoke-check freezes it as the proof of the partition).
// Those two are the runner's own selection and are NOT passed on to the checks it spawns: a check that calls this runner
// itself (no-node-smoke-check proves the shards cover the DEFAULT set) must see the default selection.
// Output under --jobs N: one line per check as it finishes (completion order), and a failing check prints its captured output
// in its own contiguous block, so two checks' output never interleave; the summary line closes the run either way.
// Caps: 120 s per check, 420 s for a browser check; doubled on macOS, whose hosted runners take about twice as long on the
// browser checks (RUN_NODE_CHECKS_PLATFORM overrides process.platform for tests only).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, 'apps', 'desktop-tauri');
const timingsFile = path.join(appDir, 'test-node', 'check-timings.json');
const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
let shard = null;
let listOnly = false;
let withCaps = false;
const on = (name) => /^(1|true|yes|on)$/i.test((process.env[name] || '').trim());
let noBrowser = on('RUN_NODE_CHECKS_NO_BROWSER');
let balanced = on('RUN_NODE_CHECKS_BALANCED');
// The default pool size may also come from the shell (RUN_NODE_CHECKS_JOBS): the island-checks job sets it to 2 on Linux and 1
// elsewhere, and a local shell can do the same. Absent, the runner keeps 1.
const envJobs = /^[0-9]+$/.test(process.env.RUN_NODE_CHECKS_JOBS || '') ? Number(process.env.RUN_NODE_CHECKS_JOBS) : 0;
let jobs = envJobs >= 1 ? envJobs : 1;
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--list') { listOnly = true; continue; }
  if (argv[i] === '--caps') { withCaps = true; continue; }
  if (argv[i] === '--no-browser') { noBrowser = true; continue; }
  if (argv[i] === '--balanced') { balanced = true; continue; }
  if (argv[i] === '--jobs') {
    const raw = argv[++i];
    if (!/^[0-9]+$/.test(raw || '') || Number(raw) < 1) { console.error('--jobs expects an integer >= 1'); process.exit(2); }
    jobs = Number(raw);
    continue;
  }
  if (argv[i] === '--shard') {
    const m = /^([0-9]+)\/([0-9]+)$/.exec(argv[++i] || '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) { console.error('--shard expects <i>/<N> with 1 <= i <= N'); process.exit(2); }
    shard = { i: Number(m[1]), n: Number(m[2]) };
    continue;
  }
  args.push(argv[i]);
}
if (balanced && !shard) { console.error('--balanced needs --shard <i>/<N>: it is the split it balances'); process.exit(2); }
const selected = args.length > 0
  ? args
  : fs.readdirSync(path.join(appDir, 'test-node'))
    .filter((f) => f.endsWith('-check.cjs') && f !== 'producer-check.cjs')
    .sort()
    .map((f) => path.join('test-node', f));
// One source read per check, shared by the cap, the browser/plain split and the platform-specific exception. An absolute path
// (the runner check passes temp files) is read as it is, not joined onto appDir.
const sourceOf = (file) => {
  try { return fs.readFileSync(path.isAbsolute(file) ? file : path.join(appDir, file), 'utf8'); } catch { return ''; }
};
const BROWSER = /chromium|playwright/;
// A browser check that is there on purpose for ONE platform (a win32 hotkey, a darwin permission) keeps running everywhere.
const PLATFORM_SPECIFIC = /process\.platform|win32|darwin/;
const isBrowser = (file) => BROWSER.test(sourceOf(file));
const isBrowserOnly = (file) => { const src = sourceOf(file); return BROWSER.test(src) && !PLATFORM_SPECIFIC.test(src); };
// `--no-browser` comes first: the shards then partition what really runs on this OS, so no shard ends up with nothing to do.
const pool = noBrowser ? selected.filter((file) => !isBrowserOnly(file)) : selected;
// Splits: balanced by measured time, or the positional round-robin this runner has always used (unchanged without --balanced).
const files = !shard ? pool : balanced ? balancedSplit(pool, shard.n)[shard.i - 1] : pool.filter((_, idx) => idx % shard.n === shard.i - 1);
if (listOnly) { for (const f of files) console.log(withCaps ? `${f}\t${capSeconds(f)}` : f); process.exit(0); }

/** Greedy longest-first over test-node/check-timings.json: each check goes to the shard that is free soonest, so the slowest
 *  shard lands near the ideal `total / N`. Ties break on the path, so the split is deterministic for a given table. */
function balancedSplit(list, n) {
  let table = {};
  try { table = JSON.parse(fs.readFileSync(timingsFile, 'utf8')); } catch { /* no table yet: every check costs the default */ }
  // The table is keyed with forward slashes; on Windows the selected path has backslashes, so normalise before the lookup.
  const secs = (file) => { const t = table[String(file).replace(/\\/g, '/')]; return Number.isFinite(t) && t > 0 ? t : 5; };
  const ordered = [...list].sort((a, b) => secs(b) - secs(a) || (a < b ? -1 : a > b ? 1 : 0));
  const bins = Array.from({ length: n }, () => ({ total: 0, files: [] }));
  for (const file of ordered) {
    let k = 0;
    for (let i = 1; i < n; i++) if (bins[i].total < bins[k].total) k = i;
    bins[k].total += secs(file);
    bins[k].files.push(file);
  }
  return bins.map((b) => b.files);
}

function capSeconds(file) {
  const browser = isBrowser(file);
  const base = Number(browser ? process.env.GEO_CAP_SECONDS || 420 : process.env.CAP_SECONDS || 120);
  const platform = process.env.RUN_NODE_CHECKS_PLATFORM || process.platform;
  return platform === 'darwin' ? base * 2 : base;
}

function killTree(child) {
  if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

function runOne(file) {
  return new Promise((resolve) => {
    const cap = capSeconds(file);
    // The runner's own selection (no-browser / balanced) is not inherited: see the header.
    const env = { ...process.env };
    delete env.RUN_NODE_CHECKS_NO_BROWSER;
    delete env.RUN_NODE_CHECKS_BALANCED;
    const child = spawn(process.execPath, ['--max-old-space-size=2048', file], { cwd: appDir, env, detached: !isWin, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, cap * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code, out, cap }); });
  });
}

/** The whole failure report of one check as a single block: its FAIL line, every failing line, then the tail, so a CI failure
 *  can be diagnosed from the log alone. Built as one string and written once, so a concurrent check cannot interleave into it. */
function failureBlock(file, code, cap, out, secs) {
  const lines = [`FAIL(${code === 124 ? `timeout ${cap}s` : code}) ${file} (${secs}s)`];
  const all = out.split(/\r?\n/);
  const hits = all.filter((l) => /FAIL|Error|FATAL|not ok|assert/i.test(l)).slice(0, 40);
  for (const l of hits) lines.push(`    ${l.slice(0, 600)}`);
  lines.push('    --- last lines ---');
  for (const l of all.slice(-15)) lines.push(`    ${l.slice(0, 600)}`);
  return lines.join('\n');
}

(async () => {
  let failed = 0;
  let cursor = 0;
  // Simple worker pool over the selected files: `jobs` workers, each taking the next file until the list is empty. With the
  // default of 1 there is a single worker, so the output is byte for byte the run this runner has always printed.
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const started = Date.now();
      const { code, out, cap } = await runOne(file);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) { process.stdout.write(`ok   ${file} (${secs}s)\n`); continue; }
      failed += 1;
      process.stdout.write(`${failureBlock(file, code, cap, out, secs)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  console.log(`node-checks: ${files.length} run, ${failed} failed`);
  process.exit(Math.min(failed, 125));
})();

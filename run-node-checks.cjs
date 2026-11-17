#!/usr/bin/env node
'use strict';
// Cross-platform runner for apps/desktop-tauri/test-node/*-check.cjs (K2-01): the same checks on Linux, macOS and Windows.
// Each check runs in its own process with a wall-clock cap and a V8 heap cap; on timeout its whole process tree is killed
// (process group on Unix, taskkill /T on Windows). run-node-checks.sh stays as the Linux-local runner with a memory cap.
// Usage: node run-node-checks.cjs [--shard <i>/<N>] [--list [--caps]] [check.cjs ...]   (paths relative to apps/desktop-tauri;
// default: every *-check.cjs except producer-check.cjs, which is not a test). `--shard i/N` keeps every N-th file of the sorted
// list starting at the i-th (1-based), so N jobs run the set in parallel and together cover it exactly once. `--list` prints
// the selected files and exits; with `--caps` each line is `<file>\t<cap seconds>`. Exit code = number of failed checks.
// Caps: 120 s per check, 420 s for a browser check; doubled on macOS, whose hosted runners take about twice as long on the
// browser checks (RUN_NODE_CHECKS_PLATFORM overrides process.platform for tests only).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, 'apps', 'desktop-tauri');
const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
let shard = null;
let listOnly = false;
let withCaps = false;
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--list') { listOnly = true; continue; }
  if (argv[i] === '--caps') { withCaps = true; continue; }
  if (argv[i] === '--shard') {
    const m = /^([0-9]+)\/([0-9]+)$/.exec(argv[++i] || '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) { console.error('--shard expects <i>/<N> with 1 <= i <= N'); process.exit(2); }
    shard = { i: Number(m[1]), n: Number(m[2]) };
    continue;
  }
  args.push(argv[i]);
}
const selected = args.length > 0
  ? args
  : fs.readdirSync(path.join(appDir, 'test-node'))
    .filter((f) => f.endsWith('-check.cjs') && f !== 'producer-check.cjs')
    .sort()
    .map((f) => path.join('test-node', f));
// Round-robin over the sorted list: the slow browser checks sit together alphabetically (island-nusa-*), so each shard gets
// a similar share of them.
const files = shard ? selected.filter((_, idx) => idx % shard.n === shard.i - 1) : selected;
if (listOnly) { for (const f of files) console.log(withCaps ? `${f}\t${capSeconds(f)}` : f); process.exit(0); }

function capSeconds(file) {
  let src = '';
  try { src = fs.readFileSync(path.join(appDir, file), 'utf8'); } catch { /* missing file: node reports it as a failure */ }
  const browser = /chromium|playwright/.test(src);
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
    const child = spawn(process.execPath, ['--max-old-space-size=2048', file], { cwd: appDir, detached: !isWin, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, cap * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code, out, cap }); });
  });
}

(async () => {
  let failed = 0;
  for (const file of files) {
    const started = Date.now();
    const { code, out, cap } = await runOne(file);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (code === 0) { console.log(`ok   ${file} (${secs}s)`); continue; }
    failed += 1;
    console.log(`FAIL(${code === 124 ? `timeout ${cap}s` : code}) ${file} (${secs}s)`);
    // Every failing line, then the tail, so a CI failure can be diagnosed from the log alone.
    const all = out.split(/\r?\n/);
    const lines = all.filter((l) => /FAIL|Error|FATAL|not ok|assert/i.test(l)).slice(0, 40);
    for (const l of lines) console.log(`    ${l.slice(0, 600)}`);
    console.log('    --- last lines ---');
    for (const l of all.slice(-15)) console.log(`    ${l.slice(0, 600)}`);
  }
  console.log(`node-checks: ${files.length} run, ${failed} failed`);
  process.exit(Math.min(failed, 125));
})();

#!/usr/bin/env node
'use strict';
// Cross-platform runner for apps/desktop-tauri/test-node/*-check.cjs (K2-01): the same checks on Linux, macOS and Windows.
// Each check runs in its own process with a wall-clock cap and a V8 heap cap; on timeout its whole process tree is killed
// (process group on Unix, taskkill /T on Windows). run-node-checks.sh stays as the Linux-local runner with a memory cap.
// Usage: node run-node-checks.cjs [check.cjs ...]   (paths relative to apps/desktop-tauri; default: every *-check.cjs
// except producer-check.cjs, which is not a test). Exit code = number of failed checks.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, 'apps', 'desktop-tauri');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const files = args.length > 0
  ? args
  : fs.readdirSync(path.join(appDir, 'test-node'))
    .filter((f) => f.endsWith('-check.cjs') && f !== 'producer-check.cjs')
    .sort()
    .map((f) => path.join('test-node', f));

function capSeconds(file) {
  let src = '';
  try { src = fs.readFileSync(path.join(appDir, file), 'utf8'); } catch { /* missing file: node reports it as a failure */ }
  const browser = /chromium|playwright/.test(src);
  return Number(browser ? process.env.GEO_CAP_SECONDS || 420 : process.env.CAP_SECONDS || 120);
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
    const lines = out.split(/\r?\n/).filter((l) => /FAIL|Error|FATAL|not ok/.test(l)).slice(0, 5);
    for (const l of lines) console.log(`    ${l.slice(0, 220)}`);
  }
  console.log(`node-checks: ${files.length} run, ${failed} failed`);
  process.exit(Math.min(failed, 125));
})();

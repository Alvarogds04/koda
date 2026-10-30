#!/usr/bin/env node
'use strict';
// Claude Code `statusLine` command: passes the plan limits to the island and keeps the user's own status line working.
// Always exits 0; stdout is exactly what the user's previous status line printed (or nothing).
const fs = require('node:fs');
const os = require('node:os');
const { extractPlan, writeChannel, readPrevious, runPrevious, runtimeDir } = require('../src/statusline.cjs');

let raw = Buffer.alloc(0);
try { raw = fs.readFileSync(0).subarray(0, 1024 * 1024); } catch { /* no stdin */ }
if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.subarray(3);

try {
  let input = null;
  try { input = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
  const plan = extractPlan(input);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const runtime = runtimeDir(process.env, uid);
  if (plan && runtime) writeChannel(runtime, plan);
  const home = process.env.HOME && require('node:path').isAbsolute(process.env.HOME) ? process.env.HOME : os.homedir();
  const previous = readPrevious(home);
  if (previous) {
    const out = runPrevious(previous, raw);
    if (out) process.stdout.write(out);
  }
} catch { /* never fail the status line */ }
process.exit(0);

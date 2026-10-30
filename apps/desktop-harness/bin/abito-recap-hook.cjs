#!/usr/bin/env node
'use strict';
// Claude Code notify-only recap hook: UserPromptSubmit / PostToolUse / Stop. Prints nothing, never blocks, exits 0.
const fs = require('node:fs');
const { reduce, appendEvent } = require('../src/recap-hook.cjs');
const { runtimeDir } = require('../src/statusline.cjs');

try {
  const raw = fs.readFileSync(0).subarray(0, 1024 * 1024);
  const record = reduce(JSON.parse(raw.toString('utf8')));
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const runtime = runtimeDir(process.env, uid);
  if (record && runtime) appendEvent(runtime, record);
} catch { /* never disturb the agent */ }
process.exit(0);

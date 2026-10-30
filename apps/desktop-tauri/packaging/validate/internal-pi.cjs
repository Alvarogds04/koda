#!/usr/bin/env node
'use strict';
// Private validator RPC fixture, copied as `pi` into its isolated PATH. No model,
// tool execution, network, hook installation or host config. Events pass through
// the real daemon runtime -> sessions wire -> Rust projection -> browser ticker.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv[2] === '--discovery-project') {
  process.chdir(process.argv[3]);
  setInterval(() => {}, 1000); // inert second discovered project, no provider
} else {
const at = process.argv.indexOf('--session-dir');
const dir = process.argv[at + 1];
const sessionFile = path.join(dir, 'validator-session.jsonl');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(sessionFile, '', { mode: 0o600 });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let started = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  emit({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'get_state' ? { sessionFile } : {} });
  if (command.type === 'get_state' && !started) {
    started = true;
    setTimeout(() => {
      for (const [toolCallId, toolName] of [['validator-read', 'read'], ['validator-bash', 'bash']]) {
        emit({ type: 'tool_execution_start', toolCallId, toolName, args: {} });
        emit({ type: 'tool_execution_end', toolCallId, toolName, isError: false, result: {} });
      }
    }, 2500);
  }
});
}

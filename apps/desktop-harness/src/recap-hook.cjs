'use strict';
// Notify-only recap hook for Claude Code (#467 T10 slice 5). Reduces a hook event to COUNTS and appends it to
// `<runtime>/recap-events.jsonl` (0600) for the island to ingest. Never kept: command text, paths, file contents,
// prompt text, cwd (only the folder's last component), tool output. Counting idea and line diff adapted from
// Coucou src-tauri/src/recap.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SPOOL = 'recap-events.jsonl';
const MAX_SPOOL = 1024 * 1024;
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Execute', 'mcp__ide__executeCode', 'run_shell_command', 'shell', 'local_shell', 'exec_command', 'run_command', 'bash']);
const DIFF_MAX_BYTES = 200 * 1024, DIFF_MAX_LINES = 4000, DIFF_MAX_CELLS = 1000000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const spoolPath = runtime => path.join(runtime, SPOOL);

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
// [added, removed] between two texts from their longest common subsequence; past the limits, everything counts.
function lineDiff(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText);
  if (oldText.length + newText.length > DIFF_MAX_BYTES || a.length + b.length > DIFF_MAX_LINES || a.length * b.length > DIFF_MAX_CELLS) return [b.length, a.length];
  let prev = new Array(b.length + 1).fill(0), row = new Array(b.length + 1).fill(0);
  for (const x of a) {
    for (let j = 0; j < b.length; j++) row[j + 1] = x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j]);
    [prev, row] = [row, prev];
  }
  const lcs = prev[b.length];
  return [b.length - lcs, a.length - lcs];
}

const clean = raw => String(raw ?? '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 128);
function project(cwd) {
  if (typeof cwd !== 'string') return '';
  const last = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  return last.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
}
const fileId = p => crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 16);

function changeOf(tool, input) {
  if (!isObj(input) || typeof input.file_path !== 'string') return null;
  let added = 0, removed = 0;
  if (tool === 'Edit') {
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null;
    [added, removed] = lineDiff(input.old_string, input.new_string);
  } else if (tool === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return null;
    for (const e of input.edits) {
      const [a, r] = lineDiff(isObj(e) && typeof e.old_string === 'string' ? e.old_string : '', isObj(e) && typeof e.new_string === 'string' ? e.new_string : '');
      added += a; removed += r;
    }
  } else if (tool === 'Write') {
    if (typeof input.content !== 'string') return null;
    added = splitLines(input.content).length;
  } else return null;
  return added > 0 || removed > 0 ? { added, removed, file: fileId(input.file_path) } : null;
}

// The reduced record for a hook payload, or null when it is not one we count.
function reduce(data, nowMs = Date.now()) {
  if (!isObj(data) || typeof data.hook_event_name !== 'string') return null;
  const base = { v: 1, at: nowMs };
  const ids = { session: clean(data.session_id) || 'unknown', project: project(data.cwd) };
  switch (data.hook_event_name) {
    case 'UserPromptSubmit': return { ...base, event: 'prompt', ...ids };
    case 'Stop': return { ...base, event: 'stop', ...ids };
    case 'PostToolUse': {
      const tool = data.tool_name;
      if (typeof tool !== 'string' || tool === '') return null;
      const rec = { ...base, event: 'tool', ...ids };
      if (COMMAND_TOOLS.has(tool)) return { ...rec, kind: 'command' };
      if (tool === 'AskUserQuestion') return { ...rec, kind: 'question' };
      const ch = changeOf(tool, data.tool_input);
      return ch ? { ...rec, kind: 'edit', ...ch } : { ...rec, kind: 'other' };
    }
    default: return null;
  }
}

// One short line with O_APPEND (atomic below PIPE_BUF-ish sizes in practice); refuses symlinks and a spool that grew too big.
function appendEvent(runtime, record) {
  try {
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > 2048) return false;
    const fd = fs.openSync(spoolPath(runtime), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_SPOOL) return false;
      fs.writeSync(fd, line);
      return true;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

module.exports = { reduce, lineDiff, appendEvent, spoolPath, SPOOL };

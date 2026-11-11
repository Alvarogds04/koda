'use strict';
// Adapted from Coucou NotchBuddy/Sources/App/HookServer.swift (nb-hook.py `codex_uses_automatic_review`), Copyright (c)
// 2026 Louis Raillé, MIT. Koda changes: Node instead of Python; only `$CODEX_HOME/sessions` is trusted (not
// `archived_sessions`); a `..` segment in the path is refused before resolving; a tail with too many records or a
// malformed `turn_context` line counts as unknown; the caller already keeps MCP and anything not Bash/apply_patch off the
// island (K2-08 T1).
//
// K2-08 T2 (S3): a Codex `PermissionRequest` that Codex's own automatic reviewer handles must not reach the island. The
// hook runs BEFORE Codex routes the approval, so for a turn whose approvals reviewer is automatic (`auto_review` or
// `strict_auto_review`, recorded in the rollout's `turn_context`) — or for Codex's internal Guardian reviewer session —
// nobody should answer a card. `codexAutoReviewed` returns true ONLY when that is proven; anything unknown, unreadable,
// missing, oversized or malformed returns false and the card is shown as before. It never decides anything itself: true
// only means «print nothing», which leaves the request to Codex.
//
// The rollout format is Codex's internal file and is not a stable contract: the rule was validated upstream only with
// Codex CLI 0.162.0-alpha.17.2 (`approvals_reviewer = "user"` and `"auto_review"`, `on-request`).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const AUTO_REVIEWERS = new Set(['auto_review', 'strict_auto_review']);
const HEADER_MAX_BYTES = 1024 * 1024;     // the first record: session_meta
const TAIL_MAX_BYTES = 8 * 1024 * 1024;   // the recent turn_context records
const TAIL_MAX_LINES = 100000;            // more complete records than this in the tail: not scanned, unknown
const GUARDIAN_SOURCE = { subagent: { other: 'guardian' } };
const NEWLINE = 0x0a;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// $CODEX_HOME (absolute only; unset or empty means Codex's default `~/.codex`), or null when it cannot be trusted.
function codexHome(env) {
  if (!isObject(env)) return null;
  const value = env.CODEX_HOME;
  if (value === undefined || value === '') return path.join(os.homedir(), '.codex');
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  return value;
}
// The real path of the transcript when it lies strictly under the real `$CODEX_HOME/sessions`, else null. Symlinks are
// resolved on both sides, so a link (file or directory) leading outside is refused before anything is opened.
function trustedRollout(transcriptPath, env) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0 || transcriptPath.includes('\0')) return null;
  if (!path.isAbsolute(transcriptPath) || transcriptPath.split(/[\\/]/).includes('..')) return null;
  const home = codexHome(env);
  if (!home) return null;
  let sessions, real;
  try {
    sessions = fs.realpathSync.native(path.join(home, 'sessions'));
    if (!fs.statSync(sessions).isDirectory()) return null;
    real = fs.realpathSync.native(transcriptPath);
  } catch {
    return null;
  }
  const rel = path.relative(sessions, real);
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return real;
}
function readSegment(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (n === 0) break;
    filled += n;
  }
  return buffer.subarray(0, filled);
}
// Newline-terminated records only: a cut-off line is not a record. `skipFirst` drops a line the window started inside.
function completeLines(blob, skipFirst) {
  let start = 0;
  if (skipFirst) {
    const first = blob.indexOf(NEWLINE);
    if (first < 0) return [];
    start = first + 1;
  }
  const lines = [];
  for (let end = blob.indexOf(NEWLINE, start); end >= 0; end = blob.indexOf(NEWLINE, start)) {
    lines.push(blob.subarray(start, end));
    start = end + 1;
    if (lines.length > TAIL_MAX_LINES) return null;
  }
  return lines;
}
function parseRecord(line) {
  try {
    const record = JSON.parse(line.toString('utf8'));
    return isObject(record) ? record : null;
  } catch {
    return null;
  }
}
// { meta, contexts } from the first HEADER_MAX_BYTES and the last TAIL_MAX_BYTES, or null when unknown. The final path
// component is opened without following a symlink (where the platform has O_NOFOLLOW) and must be a regular file.
function readRollout(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  let header, tail, tailStart;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return null;
    header = readSegment(fd, 0, Math.min(info.size, HEADER_MAX_BYTES));
    tailStart = Math.max(0, info.size - TAIL_MAX_BYTES);
    tail = readSegment(fd, tailStart, info.size - tailStart);
  } finally {
    fs.closeSync(fd);
  }
  // session_meta must be the very first complete record: a malformed first record, or one appearing later, is not trusted.
  const firstEnd = header.indexOf(NEWLINE);
  if (firstEnd < 0) return null;
  const first = parseRecord(header.subarray(0, firstEnd));
  if (!first || first.type !== 'session_meta' || !isObject(first.payload)) return null;
  const lines = completeLines(tail, tailStart > 0);
  if (!lines) return null;
  const contexts = [];
  for (const line of lines) {
    if (!line.includes('turn_context')) continue;
    const record = parseRecord(line);
    if (!record) return null; // a damaged line that may be a turn_context: unknown
    if (record.type === 'turn_context') {
      if (!isObject(record.payload)) return null;
      contexts.push(record.payload);
    }
  }
  return { meta: first.payload, contexts };
}
// True only for a proven automatic-review Codex PermissionRequest (the caller then prints nothing and sends no card).
function codexAutoReviewed(data, env) {
  try {
    if (!isObject(data) || data.hook_event_name !== 'PermissionRequest') return false;
    const tool = data.tool_name;
    if (typeof tool !== 'string' || tool.length === 0) return false; // unknown tool: unknown reviewer routing
    if (tool.startsWith('mcp__')) return false; // an MCP server can override the reviewer per call
    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    const file = trustedRollout(data.transcript_path, env);
    if (!file) return false;
    const rollout = readRollout(file);
    if (!rollout) return false;
    const { meta, contexts } = rollout;
    // Exact session identity from the rollout itself, never from a folder or file name.
    if (sessionId !== meta.id && sessionId !== meta.session_id) return false;
    // Codex's internal Guardian reviewer session: proven automatic without a turn context.
    if (meta.thread_source === 'guardian_review' && isDeepStrictEqual(meta.source, GUARDIAN_SOURCE)) return true;
    const turnId = data.turn_id;
    if (typeof turnId !== 'string' || turnId.length === 0) return false;
    let reviewer = null;
    for (const context of contexts) {
      if (context.turn_id !== turnId) continue;
      const value = context.approvals_reviewer;
      if (typeof value !== 'string' || !AUTO_REVIEWERS.has(value)) return false; // human, unknown or contradicting
      if (reviewer !== null && reviewer !== value) return false;
      reviewer = value;
    }
    return reviewer !== null;
  } catch {
    return false;
  }
}
module.exports = { codexAutoReviewed, trustedRollout, readRollout, AUTO_REVIEWERS, HEADER_MAX_BYTES, TAIL_MAX_BYTES, TAIL_MAX_LINES };

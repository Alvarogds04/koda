'use strict';
const path = require('node:path');
const { redactCommand, touchesCredentialPath, hasIndirection, hasDbAttachedOption, hiddenShellSyntax, quoteParityLoss } = require('./redact.cjs');
// Minimal, bounded UI text from harness payloads. Never throws. Bash commands are shown in full ONLY after
// secret redaction (explicit human decision, docs/REDACTION.md); file contents, env etc. never.
const MAX_INPUT = 20000;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bidi/format controls, C1 controls and lone surrogates enable visual spoofing on the island.
const SPOOF_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u0080-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const stripSpoof = s => s.replace(SPOOF_RE, '');

// Every home the process may print paths with: HOME (POSIX style, also under Git Bash on Windows) and USERPROFILE (C:\\Users\\name).
const homesOf = home => home === undefined ? [process.env.HOME, process.env.USERPROFILE] : [home];
function contractHome(s, home) {
  if (typeof home === 'string' && home.length > 1 && home.startsWith('/')) {
    return s.replace(new RegExp(escapeRe(home.replace(/\/+$/, '')) + '(?=/|\\s|$)', 'g'), '~');
  }
  if (typeof home === 'string' && /^[A-Za-z]:[\\/][^\\/]/.test(home)) {
    // Windows profile: drive path, either separator, case-insensitive (the file system is).
    const parts = home.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escapeRe);
    return s.replace(new RegExp(parts.join('[\\\\/]+') + '(?=[\\\\/]|\\s|$)', 'gi'), '~');
  }
  return s;
}
function sanitizeText(value, { max = 500, home } = {}) {
  if (typeof value !== 'string') return '';
  let s = value.length > MAX_INPUT ? value.slice(0, MAX_INPUT) : value;
  for (const h of homesOf(home)) s = contractHome(s, h);
  s = stripSpoof(s).replace(/[\t\n\r\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}
function uniqueToken(raw, used) {
  let base = typeof raw === 'string' ? raw.slice(0, 100).replace(/[^A-Za-z0-9_-]/g, '-') : '';
  if (!base) base = 'opt';
  let token = base, n = 1;
  while (used.has(token)) token = `${base}-${++n}`;
  used.add(token);
  return token;
}
// Returns at most `limit` QP/1-valid option objects with unique tokens.
function buildOptions(list, { limit = 4, home } = {}) {
  if (!Array.isArray(list)) return [];
  const used = new Set(), out = [];
  for (const item of list.slice(0, limit)) {
    let o;
    try { o = item && typeof item === 'object' ? item : {}; } catch { o = {}; }
    let value, label, description;
    try { value = o.value; label = o.label; description = o.description; } catch { /* ignore */ }
    const token = uniqueToken(value, used);
    out.push({ value: token, label: sanitizeText(label, { max: 60, home }) || token.slice(0, 60),
      description: sanitizeText(description, { max: 160, home }) });
  }
  return out;
}
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const FILE_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];
const prop = (obj, key) => { try { return obj[key]; } catch { return undefined; } };

function bashHint(command) {
  if (typeof command !== 'string') return '';
  for (const tok of stripSpoof(command.slice(0, 2000)).split(/\s+/)) {
    if (!tok || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    const base = tok.slice(tok.lastIndexOf('/') + 1);
    return /^[A-Za-z0-9_.+-]{1,40}$/.test(base) ? base : '';
  }
  return '';
}
function fileHint(input, home) {
  for (const key of FILE_KEYS) {
    const v = prop(input, key);
    if (typeof v === 'string' && v.length > 0) {
      return sanitizeText(path.posix.basename(v.slice(0, 4096).replace(/\/+$/, '')), { max: 40, home });
    }
  }
  return '';
}
// SHORT text: tool name plus an optional bounded hint (Bash: first token; file tools: basename).
function describeTool(name, input, { home } = {}) {
  try {
    const safe = typeof name === 'string'
      ? name.slice(0, 200).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : '';
    const tool = safe || 'tool';
    let hint = '';
    if (input && typeof input === 'object') {
      if (tool === 'Bash') hint = bashHint(prop(input, 'command'));
      else if (FILE_TOOLS.has(tool)) hint = fileHint(input, home);
    }
    return sanitizeText(hint ? `${tool}: ${hint}` : tool, { max: 100, home });
  } catch { return 'tool'; }
}
// Only a plain object with zero own enumerable keys counts as "no arguments"; missing/null/array/primitive is lossy.
const emptyInput = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
const BASH_EXTRA_OK = new Set(['command', 'description', 'timeout']);
const MAX_BASH_DISPLAY = 380, MAX_BASH_LOSSY_DISPLAY = 300;
const REASONS = Object.freeze({ long: 'long command', special: 'special characters', creds: 'touches credential files', indirection: 'shell indirection', hidden: 'hidden text may contain shell syntax' });
// Full redacted Bash command. Lossless (allow may be offered) only when the display is a faithful, single-line,
// printable ASCII / closed visible Latin allow-list, NFC, short, indirection-free, credential-path-free
// rendering. Checks use the ORIGINAL command; never normalize or escape a command into approval.
// Cost bound: a command over MAX_BASH_SCAN UTF-16 units is always lossy ('long command'), so every scan, the
// redaction and the display work on its first MAX_BASH_SCAN units only (the display is cut far earlier anyway).
const MAX_BASH_SCAN = 4096;
// Only precomposed Latin-1 letters (not multiplication/division), plus explicit visible
// punctuation. Everything else is lossy: controls, marks, other scripts, format/default-ignorables,
// private/unassigned code points, surrogates, emoji. Extended-A/B is wholly excluded: its letters
// include ASCII/operator confusables (long s, dotless i, clicks). No whitespace beyond ASCII space.
const BASH_VISIBLE = /^[\x20-\x7e\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff\u00a1\u00ab\u00bb\u00bf\u2013\u2014\u2018\u2019\u201c\u201d\u2026]+$/u;
function describeBash(full, fallbackText) {
  if (full.length === 0) return { text: fallbackText, lossy: true };
  const isLong = full.length > MAX_BASH_SCAN;
  let command = isLong ? full.slice(0, MAX_BASH_SCAN) : full;
  if (isLong && /[\ud800-\udbff]$/.test(command)) command = command.slice(0, -1); // never end on a lone high surrogate
  const { text: redacted, redactions, spans } = redactCommand(command);
  let reason = null;
  if (!BASH_VISIBLE.test(command) || command !== command.normalize('NFC') || command.trim() === '' || command.includes('[REDACTED]')) reason = REASONS.special;
  else if (hasIndirection(command)) reason = REASONS.indirection;
  else if (touchesCredentialPath(command)) reason = REASONS.creds;
  else if (hasDbAttachedOption(command)) reason = REASONS.special;
  else if (hiddenShellSyntax(spans) || (redactions > 0 && quoteParityLoss(command, redacted))) reason = REASONS.hidden;
  else if (redacted.startsWith('[REDACTED]')) reason = REASONS.special; // the command word itself is hidden
  else if (isLong || [...redacted].length > MAX_BASH_DISPLAY) reason = REASONS.long;
  if (!reason) return { text: 'Bash: ' + redacted, lossy: false, redactions };
  const shown = sanitizeText(redacted, { max: MAX_BASH_LOSSY_DISPLAY, home: null });
  return { text: shown ? 'Bash: ' + shown : fallbackText, lossy: true, reason, redactions };
}
// {text, lossy[, reason, redactions]}: lossy=true whenever the short text drops material the human would need to decide.
// Lossless only for: Bash passing describeBash (full redacted command); an MCP tool whose tool_input is an empty plain object.
function describeToolDetailed(name, input, { home } = {}) {
  let text = 'tool';
  try { text = describeTool(name, input, { home }); } catch { /* describeTool never throws */ }
  try {
    if (typeof name !== 'string' || name.length === 0) return { text, lossy: true };
    const sanitizedName = name.slice(0, 200).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (sanitizedName !== name) return { text, lossy: true }; // name itself was altered or truncated
    if (name === 'Bash') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { text, lossy: true };
      const keys = Object.keys(input);
      if (keys.some(k => !BASH_EXTRA_OK.has(k)) || typeof input.command !== 'string') return { text, lossy: true };
      return describeBash(input.command, text);
    }
    if (FILE_TOOLS.has(name)) return { text, lossy: true };
    if (name.startsWith('mcp__') && name.split('__').length !== 3) return { text, lossy: true };
    if (!name.startsWith('mcp__')) return { text, lossy: true }; // unknown non-MCP tool: always lossy
    return { text, lossy: !emptyInput(input) };
  } catch { return { text, lossy: true }; }
}
module.exports = { sanitizeText, buildOptions, describeTool, describeToolDetailed };

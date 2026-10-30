'use strict';
// Helpers shared by the CLI hook adapters (Claude Code, Codex): argument parsing, watchdog, decision
// lines, consent option sets and tool descriptions. Adapters own their event contracts.
const fs = require('node:fs');
const path = require('node:path');
const { IslandClient, formatNoDecision } = require('./client.cjs');
const { resolveConfig } = require('./config.cjs');
const { computeDeadline } = require('./deadline.cjs');
const { sessionToken } = require('./identity.cjs');
const { describeTool, describeToolDetailed, sanitizeText } = require('./projection.cjs');

const MAX_STDIN_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 35, STOP_WATCHDOG_MS = 15000, MAX_ISLAND_WAIT_MS = 60000;
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n';
const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
  decision: { behavior: 'deny', message: 'Denied from the Koda island by the user.' } } }) + '\n';
// Option sets per agent. LOSSY_OPTIONS is offered when the island cannot show the whole request:
// `allow` is deliberately absent. Only the agents that can still ANSWER mint an option set (S4/T2 removed Codex's:
// Codex only ever sends a notice, so nothing in this file is reached with agent 'Codex' any more).
function optionSets(agent, short = agent) {
  if (agent === 'Claude Code') {
    const deny = { value: 'deny', label: 'Rechazar', description: `Rechazar la solicitud de ${short}` };
    return {
      OPTIONS: [{ value: 'allow', label: 'Aprobar una vez', description: `Permitir esta solicitud de ${agent} una vez` }, deny],
      LOSSY_OPTIONS: [deny, { value: 'terminal', label: 'Decidir en la terminal', description: `Continuar con el permiso de ${agent} en la terminal; la tarjeta se cierra` }],
    };
  }
  const deny = { value: 'deny', label: 'Deny', description: `Refuse; ${short} is told you declined` };
  return {
    OPTIONS: [{ value: 'allow', label: 'Allow once', description: `Let ${agent} run it this time` }, deny],
    LOSSY_OPTIONS: [deny, { value: 'terminal', label: 'Decide in the terminal',
      description: `The ${agent} prompt in the terminal stays in charge` }],
  };
}

// Returns {timeoutSec} or null when the arguments are invalid.
function parseArgs(argv) {
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--timeout-sec' || i + 1 >= argv.length) return null;
    const v = argv[++i];
    if (!/^[0-9]{1,4}$/.test(v)) return null;
    timeoutSec = Number(v);
    if (timeoutSec < 1 || timeoutSec > 3600) return null;
  }
  return { timeoutSec };
}
// Process must exit by itself no later than deadline + 5 s (= the hook timeout) for questions. Questions (permissions
// and AskUserQuestion alike) only arrive on permission-request; that is the only event holding the island open.
function watchdogMs(event, timeoutSec) { return event === 'permission-request' ? timeoutSec * 1000 : STOP_WATCHDOG_MS; }
function startWatchdog(ms, onFire, setTimer = setTimeout) {
  const h = setTimer(onFire, ms);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
}

const none = (stderr = '') => ({ stdout: '', stderr, exitCode: 0 });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function validCwd(cwd) {
  try { return typeof cwd === 'string' && cwd.length < 4096 && path.isAbsolute(cwd) && !cwd.includes('\0') && fs.statSync(cwd).isDirectory(); }
  catch { return false; }
}
function toolDescription(name, toolInput) {
  const n = typeof name === 'string' ? name : '';
  if (n.startsWith('mcp__')) {
    const parts = n.split('__');
    const server = describeTool(parts[1], {}), tool = describeTool(parts[parts.length - 1], {});
    return { text: `mcp tool ${server}/${tool}`, lossy: describeToolDetailed(n, toolInput).lossy };
  }
  const d = describeToolDetailed(n, toolInput);
  return { text: d.text, lossy: d.lossy, reason: d.reason, redactions: d.redactions };
}
// Shared question text. Lossless Bash shows the full redacted command (never sanitizeText-collapsed: it is
// printable ASCII / closed visible Latin allow-list, NFC by construction); everything else keeps the short description.
function questionText(agent, detail) {
  if (agent === 'Claude Code') {
    const reasons = { 'long command': 'comando recortado', 'special characters': 'caracteres especiales',
      'touches credential files': 'ruta sensible', 'shell indirection': 'indirección de shell',
      'hidden text may contain shell syntax': 'el texto oculto puede contener sintaxis de shell' };
    const bash = detail.text?.startsWith('Bash: ') && detail.redactions !== undefined;
    const shown = detail.filePreview || bash ? detail.text : sanitizeText(detail.text, { max: 120 })
      .replace(/^mcp tool /, 'herramienta MCP ').replace('(file edit)', '(edición de archivo)').replace(/^tool$/, 'herramienta');
    const secrets = detail.redactions > 0 ? ' (secretos ocultos)' : '';
    const reason = detail.reason ? `${reasons[detail.reason] || detail.reason}; ` : '';
    const tail = detail.lossy ? ` (${reason}detalles solo en la terminal; decidir en la terminal)` : '';
    const text = `${agent} pide permiso para ${shown}${secrets}${tail}`;
    // Never silently truncate an approvable request (file previews are bounded before this point).
    return detail.lossy && [...text].length > 500 ? `${agent} pide permiso (recortado; detalles solo en la terminal)` : text;
  }
  const isBash = typeof detail.text === 'string' && detail.text.startsWith('Bash: ') && detail.redactions !== undefined;
  if (!detail.lossy) {
    if (isBash) return `${agent} asks permission: ${detail.text}${detail.redactions > 0 ? ' (secrets hidden)' : ''}`;
    return sanitizeText(`${agent} asks permission: ${sanitizeText(detail.text, { max: 120 })}`, { max: 500 });
  }
  const description = isBash ? detail.text : sanitizeText(detail.text, { max: 120 });
  const why = isBash && detail.reason ? `${detail.reason}; ` : '';
  const tail = ` (${why}details only in the terminal)`;
  return sanitizeText(`${agent} asks permission for ${description}${tail}`, { max: 500 });
}
function defaultFactory(options) { return new IslandClient(options); }

// Maps a client result to the adapter output. Only an `answered` option allow|deny becomes a decision,
// and `allow` only when the request was lossless (never for a forged answer to a lossy question).
function mapResult(result, lossy) {
  if (result && result.status === 'answered' && result.answer && result.answer.type === 'option') {
    if (result.answer.value === 'allow' && !lossy) return { stdout: ALLOW, stderr: '', exitCode: 0 };
    if (result.answer.value === 'deny') return { stdout: DENY, stderr: '', exitCode: 0 };
  }
  if (result && result.status === 'unavailable') return none('Koda island unavailable. Answer in the terminal.\n');
  return none(formatNoDecision(result) + '\n');
}

module.exports = { parseArgs, watchdogMs, startWatchdog, none, isObject, validCwd, toolDescription, defaultFactory, mapResult, optionSets, questionText,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, STOP_WATCHDOG_MS, MAX_ISLAND_WAIT_MS, ALLOW, DENY,
  IslandClient, formatNoDecision, resolveConfig, computeDeadline, sessionToken, sanitizeText };

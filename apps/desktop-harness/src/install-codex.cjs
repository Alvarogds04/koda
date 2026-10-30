'use strict';
// Codex hooks installer: same safety model as install-claude.cjs (shared core), Codex profile.
// Codex hooks.json entries have NO args array: `command` is a shell string, so every path is POSIX single-quoted.
// Trust state in ~/.codex/config.toml is never read or written.
//
// S4/T2 (human decision L3, option A «Solo aviso para Codex»): the installed entries are NOTICE-ONLY.
//   PermissionRequest                  -> «Codex te pide permiso» + «Respondé en la terminal»
//   PreToolUse (matcher request_user_input, plan-mode questions) -> «Codex te pregunta» + «Respondé en la terminal»
//   PostToolUse (every tool: a pending approval blocks the turn)   -> the clearing frame, so the notice goes at once
//   Stop                               -> the finished notice (unchanged) + the clearing frame for the attention notice
// No entry carries `--timeout-sec` any more: a notice never waits for an island answer, so the Codex hook timeout is a
// short 5 s bound instead of a 35 s question budget. Nothing here can answer for Codex; the approval prompt is Codex's.
const path = require('node:path');
const core = require('./install-claude.cjs');

const STOP_TIMEOUT_SEC = 15;
// Fire-and-forget: the hook only connects, sends one notice and exits. 5 s is the hard stop, not a question budget.
const NOTICE_TIMEOUT_SEC = 5;
const EVENTS = ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop'];
// Codex's plan-mode questions arrive as the `request_user_input` tool: the ONLY PreToolUse we observe.
const MATCHERS = { PreToolUse: 'request_user_input' };
const USAGE = 'usage: abito-hook install codex (--settings <abs path to hooks.json> | --user) [--timeout-sec N] [--remove] [--apply]\n';
const refuse = m => new core.InstallError(65, 'refused: ' + m);

function checkShellPath(p, what) {
  if (typeof p !== 'string' || p === '' || /[\0\n\r]/.test(p) || !path.isAbsolute(p)) throw refuse(what + ' must be an absolute path without NUL, newline or carriage return');
  return p;
}
function shellQuote(s) {
  checkShellPath(s, 'path');
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const commandBase = (execPath, binPath) => `${shellQuote(execPath)} ${shellQuote(binPath)} codex `;
// Legacy shape only: an install made by the removed answered path asked the island with a question budget.
const LEGACY_PERM_SUB = 'permission-request --timeout-sec ';
const NOTICE_SUBS = { PermissionRequest: 'permission-request', PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use', Stop: 'stop' };

const CODEX_PROFILE = {
  name: 'codex',
  defaultFile: ['.codex', 'hooks.json'],
  events: EVENTS,
  matchers: MATCHERS,
  defaultTimeoutSec: NOTICE_TIMEOUT_SEC,
  usage: USAGE,
  checkPaths: (binPath, execPath) => { checkShellPath(binPath, 'hook script path'); checkShellPath(execPath, 'node path'); },
  // Fixed entries: no user value ever reaches the command string (a notice needs no timeout and no flag).
  buildEntry: (event) => {
    const sub = NOTICE_SUBS[event];
    if (!sub) throw new core.InstallError(64, 'unknown codex hook event');
    return { type: 'command', command: commandBase(process.execPath, core.BIN_PATH) + sub, timeout: event === 'Stop' ? STOP_TIMEOUT_SEC : NOTICE_TIMEOUT_SEC, statusMessage: 'Koda island' };
  },
  // Ours = the exact generated command shape (both ends anchored, execPath included); anything else is third-party.
  // The legacy `permission-request --timeout-sec N` entry is OURS too: it is the answered install this version migrates.
  isOurs: (h, binPath, execPath) => {
    if (!core.isObj(h) || h.type !== 'command' || typeof h.command !== 'string') return false;
    let base;
    try { base = commandBase(execPath, binPath); } catch { return false; }
    const c = h.command;
    if (Object.values(NOTICE_SUBS).some(sub => c === base + sub)) return true;
    if (!c.startsWith(base + LEGACY_PERM_SUB)) return false;
    const n = c.slice(base.length + LEGACY_PERM_SUB.length);
    return /^[0-9]{1,4}$/.test(n) && Number(n) >= 1 && Number(n) <= 3600 && String(Number(n)) === n;
  },
  previewNotes: plan => plan.remove ? [] : [
    `Target hooks file: ${plan.settingsPath}`,
    'IMPORTANT: Codex marks new or changed hooks as untrusted until you review them in /hooks; until then they do nothing. Review and trust them there yourself. This installer never touches ~/.codex/config.toml.',
    'Note: Codex only ever sends the island a NOTICE («Codex te pide permiso / Codex te pregunta… Respondé en la terminal»). The approval prompt stays in the terminal and the island never answers for Codex.',
  ],
  postNotes: plan => plan.remove ? [] : ['Next: open Codex and review/trust the Koda hooks in /hooks; they are inactive until you do.'],
};

// The plan-level builder needs the real paths: `planClaudeSettings` passes its own binPath/execPath into buildEntry.
const withPaths = (profile) => ({
  ...profile,
  buildEntry: (event, _timeoutSec, binPath, execPath) => {
    const sub = NOTICE_SUBS[event];
    if (!sub) throw new core.InstallError(64, 'unknown codex hook event');
    return { type: 'command', command: commandBase(execPath, binPath) + sub, timeout: event === 'Stop' ? STOP_TIMEOUT_SEC : NOTICE_TIMEOUT_SEC, statusMessage: 'Koda island' };
  },
});

const CODEX = withPaths(CODEX_PROFILE);
const planCodexHooks = o => core.planClaudeSettings({ ...o, profile: CODEX });
const runInstallCodex = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: CODEX });

module.exports = { CODEX_PROFILE: CODEX, USAGE, shellQuote, planCodexHooks, runInstallCodex, EVENTS, MATCHERS, NOTICE_TIMEOUT_SEC, STOP_TIMEOUT_SEC };

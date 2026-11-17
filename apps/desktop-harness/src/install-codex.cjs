'use strict';
// Codex hooks installer: same safety model as install-claude.cjs (shared core), Codex profile.
// Codex hooks.json entries have NO args array: `command` is a shell string, so every path is POSIX single-quoted.
// Trust state in ~/.codex/config.toml is never read or written: the human trusts the hooks in Codex's /hooks, and must
// do it again after every install or update (Codex trusts a hook by its hash, so a changed command or timeout is new).
//
// K2-08 T3 (S2, S4, S5; reverses the code-only decision S4/T2 «Solo aviso para Codex»):
//   PermissionRequest                  -> answered from the island (codex.cjs): `--timeout-sec 120`, entry timeout
//                                         120 s, statusMessage «Esperando tu respuesta en Koda» (shown by Codex while
//                                         the hook waits). No answer in time or no island => Codex asks in its terminal.
//   PreToolUse (matcher request_user_input, plan-mode questions) -> «Codex te pregunta» + «Respondé en la terminal»
//   PostToolUse (every tool: a pending approval blocks the turn)   -> the clearing frame, so the notice goes at once
//   Stop                               -> the finished notice (unchanged) + the clearing frame for the attention notice
// The three notice entries stay fire-and-forget with a short 5 s bound (Stop 15 s).
// Windows: Codex runs hook commands with `cmd /C` (Coucou, MIT, agents.rs), where POSIX single quotes mean nothing, so on
// Windows drive paths every entry also carries `commandWindows`: `""<node>" "<hook>" codex <event>"`. cmd /C strips the
// outer pair of quotes and runs the rest, so both paths stay one argument each even with spaces or non-ASCII letters.
const path = require('node:path');
const core = require('./install-claude.cjs');
const winfs = require('./win-fs.cjs');

const STOP_TIMEOUT_SEC = 15;
// Fire-and-forget: the hook only connects, sends one notice and exits. 5 s is the hard stop, not a question budget.
const NOTICE_TIMEOUT_SEC = 5;
// S5: Codex waits 120 s for the island's answer (the hook asks with this budget less its 5 s margin: 115 s).
const PERMISSION_TIMEOUT_SEC = 120;
const WAITING_MESSAGE = 'Esperando tu respuesta en Koda';
const NOTICE_STATUS = 'Koda island';
const EVENTS = ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop'];
// Codex's plan-mode questions arrive as the `request_user_input` tool: the ONLY PreToolUse we observe.
const MATCHERS = { PreToolUse: 'request_user_input' };
const USAGE = 'usage: koda-hook install codex (--settings <abs path to hooks.json> | --user) [--timeout-sec N] [--remove] [--apply]\n';
const refuse = m => new core.InstallError(65, 'refused: ' + m);

// A Windows drive path (`C:\…`). Only those get a `commandWindows`; they are accepted as absolute on every OS.
const isWinDrivePath = p => typeof p === 'string' && /^[A-Za-z]:\\/.test(p);
function checkShellPath(p, what) {
  if (typeof p !== 'string' || p === '' || /[\0\n\r]/.test(p) || !(path.isAbsolute(p) || isWinDrivePath(p))) throw refuse(what + ' must be an absolute path without NUL, newline or carriage return');
  return p;
}
function shellQuote(s) {
  checkShellPath(s, 'path');
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
// cmd double quotes; characters cmd would expand or that end the quoted string are refused (HU-047 L6, win-fs.cjs).
function cmdQuote(p) {
  try { return winfs.quoteWindowsCommandPath(p); } catch { throw refuse('a Windows command path must not contain " % ^ & | < > or control characters'); }
}

const commandBase = (execPath, binPath) => `${shellQuote(execPath)} ${shellQuote(binPath)} codex `;
// Recognized as ours: `permission-request --timeout-sec N` (this version writes N = 120; older answered installs wrote
// other N and are migrated in place).
const PERM_SUB = 'permission-request --timeout-sec ';
const SUBS = { PermissionRequest: PERM_SUB + PERMISSION_TIMEOUT_SEC, PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use', Stop: 'stop' };
// The notice-era (S4/T2) subcommands, all recognized as ours. `permission-request` alone is the 5 s notice entry T3 migrates.
const NOTICE_SUBS = ['permission-request', 'pre-tool-use', 'post-tool-use', 'stop'];
// K2-04 (S2, S4): the same entry shape with a Koda 0.1 script name (`'<node>' '<.../abito-hook.cjs>' codex <sub>`, from
// whichever directory that install lived in) is OURS too: it is replaced in place, so Codex keeps ONE card per notice. The
// script word must be one complete POSIX-quoted word whose basename is exactly our script name (never a look-alike).
const QUOTED_WORD = /^'(?:[^']|'\\'')*'$/;
const unquote = word => word.slice(1, -1).replace(/'\\''/g, "'");
/** `{script, tail}` when `command` is `<node> <script> codex <tail>`, else null. Anchored on both quoted words. */
function splitCommand(command, execPath) {
  let head;
  try { head = shellQuote(execPath) + ' '; } catch { return null; }
  if (!command.startsWith(head)) return null;
  const rest = command.slice(head.length);
  const at = rest.indexOf(' codex ');
  if (at < 0) return null;
  const word = rest.slice(0, at);
  if (!QUOTED_WORD.test(word)) return null;
  return { script: unquote(word), tail: rest.slice(at + ' codex '.length) };
}
/** A sub we install, current or from the notice era (same rules as the exact-command check below). */
function isKnownSub(tail) {
  if (NOTICE_SUBS.includes(tail)) return true;
  if (!tail.startsWith(PERM_SUB)) return false;
  const n = tail.slice(PERM_SUB.length);
  return /^[0-9]{1,4}$/.test(n) && Number(n) >= 1 && Number(n) <= 3600 && String(Number(n)) === n;
}

// Fixed entries: no user value ever reaches the command string (the CLI `--timeout-sec` flag is validated and inert).
function buildEntry(event, binPath, execPath) {
  const sub = SUBS[event];
  if (!sub) throw new core.InstallError(64, 'unknown codex hook event');
  const entry = { type: 'command', command: commandBase(execPath, binPath) + sub };
  if (isWinDrivePath(execPath) && isWinDrivePath(binPath)) entry.commandWindows = `"${cmdQuote(execPath)} ${cmdQuote(binPath)} codex ${sub}"`;
  const perm = event === 'PermissionRequest';
  entry.timeout = perm ? PERMISSION_TIMEOUT_SEC : event === 'Stop' ? STOP_TIMEOUT_SEC : NOTICE_TIMEOUT_SEC;
  entry.statusMessage = perm ? WAITING_MESSAGE : NOTICE_STATUS;
  return entry;
}

const CODEX_PROFILE = {
  name: 'codex',
  defaultFile: ['.codex', 'hooks.json'],
  events: EVENTS,
  matchers: MATCHERS,
  defaultTimeoutSec: PERMISSION_TIMEOUT_SEC,
  usage: USAGE,
  checkPaths: (binPath, execPath) => {
    checkShellPath(binPath, 'hook script path'); checkShellPath(execPath, 'node path');
    if (isWinDrivePath(binPath) && isWinDrivePath(execPath)) { cmdQuote(binPath); cmdQuote(execPath); }
  },
  // planClaudeSettings passes its own binPath/execPath into buildEntry.
  buildEntry: (event, _timeoutSec, binPath, execPath) => buildEntry(event, binPath, execPath),
  // Ours = the exact generated `command` shape (both ends anchored, execPath included); anything else is third-party.
  // `commandWindows` never decides ownership: a changed one only makes our entry a `replace`.
  isOurs: (h, binPath, execPath) => {
    if (!core.isObj(h) || h.type !== 'command' || typeof h.command !== 'string') return false;
    const c = h.command;
    let base;
    try { base = commandBase(execPath, binPath); } catch { return false; }
    if (c.startsWith(base + PERM_SUB)) {
      const n = c.slice(base.length + PERM_SUB.length);
      if (/^[0-9]{1,4}$/.test(n) && Number(n) >= 1 && Number(n) <= 3600 && String(Number(n)) === n) return true;
    } else if (NOTICE_SUBS.some(sub => c === base + sub)) return true;
    // K2-04: a 0.1 entry (same rule as claude: the script basename must be exactly ours) is ours as well.
    const parts = splitCommand(c, execPath);
    return !!parts && core.isHookScript(parts.script) && isKnownSub(parts.tail);
  },
  previewNotes: plan => plan.remove ? [] : [
    `Target hooks file: ${plan.settingsPath}`,
    'IMPORTANT: Codex marks new or changed hooks as untrusted until you review them in /hooks; until then they do nothing. After every install or update, open Codex, run /hooks and trust the Koda hooks again yourself (a changed command or timeout is a new hook for Codex). This installer never touches ~/.codex/config.toml.',
    `Koda answers Codex permission requests from the island: Codex waits up to ${PERMISSION_TIMEOUT_SEC} s and shows «${WAITING_MESSAGE}» meanwhile. With the island closed, or no answer in time, Codex asks in the terminal as usual. Plan-mode questions stay a notice («Respondé en la terminal»).`,
  ],
  postNotes: plan => plan.remove ? [] : ['Next: open Codex, run /hooks and trust the Koda hooks again; they are inactive until you do.'],
};

const planCodexHooks = o => core.planClaudeSettings({ ...o, profile: CODEX_PROFILE });
const runInstallCodex = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: CODEX_PROFILE });

module.exports = { CODEX_PROFILE, USAGE, shellQuote, planCodexHooks, runInstallCodex, EVENTS, MATCHERS, NOTICE_TIMEOUT_SEC, STOP_TIMEOUT_SEC,
  PERMISSION_TIMEOUT_SEC, WAITING_MESSAGE, splitCommand, isKnownSub };

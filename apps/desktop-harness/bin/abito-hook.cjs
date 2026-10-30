#!/usr/bin/env node
'use strict';
// Install: node bin/abito-hook.cjs install <claude|codex|copilot|opencode|statusline|recap> (--settings <abs path> | --user) [--timeout-sec N] [--remove] [--apply]
// Usage: node bin/abito-hook.cjs <claude|codex> <permission-request|pre-tool-use|post-tool-use|session-start|stop> [--timeout-sec N]
// stdout is either empty or exactly one hook JSON line; exit 0 always except usage errors (64).
const { handleClaudeHook, parseArgs, watchdogMs, startWatchdog, MAX_STDIN_BYTES } = require('../src/claude.cjs');
const { handleCodexHook } = require('../src/codex.cjs');
const { handleCopilotHook } = require('../src/copilot.cjs');
const { handleOpencodeHook } = require('../src/opencode.cjs');

const STDIN_TIMEOUT_MS = 5000;
const EVENTS = ['permission-request', 'pre-tool-use', 'post-tool-use', 'session-start', 'stop'];
// Claude answers its questions on PermissionRequest (S2/S6, ad0ae382), so `claude pre-tool-use` stays a usage error.
// The two tool events are the Codex notice observer (S4/T2): plan-mode questions (`pre-tool-use`) and the clearing
// signal after a tool ran (`post-tool-use`). Copilot/OpenCode only ever see a permission request.
const CLAUDE_EVENTS = ['permission-request', 'session-start', 'stop'];
const CODEX_EVENTS = EVENTS;
function allowedEvent(subcommand, event) {
  if (subcommand === 'claude') return CLAUDE_EVENTS.includes(event);
  if (subcommand === 'codex') return CODEX_EVENTS.includes(event);
  return event === 'permission-request'; // copilot | opencode
}
function usage() { process.stderr.write(`usage: abito-hook <claude|codex> <${EVENTS.join('|')}> [--timeout-sec 1..3600]\n`); process.exit(64); }

function readStdin() {
  return new Promise(resolve => {
    const chunks = []; let size = 0, done = false;
    const stdin = process.stdin;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { stdin.removeAllListeners('data'); stdin.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);
    stdin.on('data', c => {
      size += c.length;
      if (size > MAX_STDIN_BYTES) { finish(null); return; }
      chunks.push(c);
    });
    stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', () => finish(null));
  });
}

// Island/--json contract: stdout is authoritative and stderr stays empty, whatever happens.
//  - a broken stdout pipe (EPIPE) is ignored; the exit code still matches the JSON that was or would have been printed;
//  - a stray crash after the verdict is known exits with that verdict's code, silently;
//  - a stray crash before any verdict prints ONE fixed JSON error (best effort) and exits 70.
const INTERNAL_LINE = '{"schema":"abito-hook-install/1","ok":false,"code":"internal","message":"internal error"}\n';
const EXIT_OF = { usage: 64, refused: 65, foreign_extension: 65, unsafe_folder: 65, not_writable: 65, unsafe_target: 65, install_unverified: 65, apply_failed: 70, plan_changed: 70, audit_unavailable: 73, not_island: 77, unsupported_platform: 77 };
const exitOfJson = o => (o && o.ok === true ? 0 : o && EXIT_OF[o.code] !== undefined ? EXIT_OF[o.code] : 70);
async function runIsland(argv) {
  let verdict = null;
  const die = () => {
    if (verdict === null) { try { require('node:fs').writeSync(1, INTERNAL_LINE); } catch { /* best effort */ } process.exit(70); }
    process.exit(verdict);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  process.stdout.on('error', () => { /* EPIPE and friends: the verdict is already decided */ });
  const out = s => { try { process.stdout.write(s); } catch { /* ignore */ } };
  const code = await require('../src/install-ui.cjs').runInstallUi(argv, { out, onJson: o => { verdict = exitOfJson(o); } });
  process.exitCode = verdict !== null ? verdict : code;
}

async function runInstaller(argv) {
  if (argv.some(a => a === '--json' || a === '--apply-plan' || a === '--audit-dir')) {
    // island install mode: one JSON line on stdout, nothing on stderr, no TTY (src/install-ui.cjs, docs/ISLAND-INSTALL.md)
    await runIsland(argv);
    return;
  }
  if (argv[0] === 'pi') {
    process.stderr.write('usage: abito-hook install pi --user [--remove] --json [--apply-plan <hash> --audit-dir <abs path>] (Linux, macOS and Windows)\n');
    process.exitCode = 64; return;
  }
  const { runInstall, askLine, promptTimeoutFromEnv } = require('../src/install-claude.cjs');
  const { runInstallCodex } = require('../src/install-codex.cjs');
  const state = { timedOut: false };
  const ms = promptTimeoutFromEnv(process.env);
  const prompt = q => askLine(process.stdin, process.stdout, q, ms, state);
  if (argv[0] === 'statusline') {
    // Claude Code status-line relay for plan usage: same preview/backup/typed-word pattern (src/install-statusline.cjs)
    process.exitCode = await require('../src/install-statusline.cjs').runStatusLineInstall(argv.slice(1), { prompt });
    return;
  }
  if (argv[0] === 'recap') {
    // notify-only recap hooks (UserPromptSubmit/PostToolUse/Stop): same pattern (src/install-recap.cjs)
    process.exitCode = await require('../src/install-recap.cjs').runRecapInstall(argv.slice(1), { prompt });
    return;
  }
  const run = argv[0] === 'codex' ? runInstallCodex : argv[0] === 'copilot' ? require('../src/install-copilot.cjs').runInstallCopilot : argv[0] === 'opencode' ? require('../src/install-opencode.cjs').runInstallOpencode : runInstall;
  process.exitCode = await run(argv, { prompt, timedOut: () => state.timedOut }); // usage text goes to stderr on 64
}

// Never print and never exit non-zero from a stray async error: no decision is the safe outcome.
if (process.argv[2] !== 'install') {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

async function main() {
  if (process.argv[2] === 'install') { await runInstaller(process.argv.slice(3)); return; }
  const [subcommand, event, ...rest] = process.argv.slice(2);
  if (!['claude', 'codex', 'copilot', 'opencode'].includes(subcommand) || !allowedEvent(subcommand, event)) usage();
  const args = parseArgs(rest);
  if (!args) usage();
  startWatchdog(watchdogMs(event, args.timeoutSec), () => process.exit(0));
  const input = await readStdin();
  const result = input === null ? { stdout: '', stderr: '', exitCode: 0 }
    : await ({ codex: handleCodexHook, copilot: handleCopilotHook, opencode: handleOpencodeHook }[subcommand] || handleClaudeHook)({ event, input, env: process.env, argv: rest });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout, () => process.exit(0)); else process.exit(0);
}
main().catch(() => process.exit(0));

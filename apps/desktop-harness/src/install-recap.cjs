'use strict';
// K2-03 T3 (S2, S4): REMOVAL-ONLY legacy profile. Recap (the weekly summary) was removed in 0.2 together with its hook script;
// Koda 0.1 could have installed three notify-only entries (UserPromptSubmit, PostToolUse, Stop) in ~/.claude/settings.json
// that call `.../bin/abito-recap-hook.cjs`. This profile only takes those entries out (same preview / dated backup / marker-only
// removal / byte-exact patch of the "hooks" member as install-claude.cjs); installing is refused. The daemon runs it once at
// start (desktop-daemon/src/agents.cjs) so Claude Code stops calling a deleted script. Same path on Linux, macOS and Windows
// (~/.claude, %USERPROFILE%\.claude via resolveUserSettings).
// TODO(K2-03 follow-up): remove one version after K2-03 ships.
const path = require('node:path');
const ic = require('./install-claude.cjs');

// The 0.1 script path of THIS install (deleted now); entries from any former install match by file name (isOurs).
const RECAP_BIN = path.resolve(__dirname, '../bin/abito-recap-hook.cjs');
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const TIMEOUT_SEC = 5;
const USAGE = 'usage: koda-hook install recap --user --remove [--apply]   (Recap was removed: only its old hooks can be taken out)\n';

const PROFILE = {
  name: 'recap',
  defaultFile: ['.claude', 'settings.json'],
  events: EVENTS,
  defaultTimeoutSec: TIMEOUT_SEC,
  usage: USAGE,
  checkPaths: () => {},
  buildEntry: (_event, timeoutSec, binPath, execPath) => ({ type: 'command', command: execPath, args: [binPath], timeout: timeoutSec }),
  isOurs: (h, binPath) => ic.isObj(h) && h.type === 'command' && Array.isArray(h.args) && (h.args.includes(binPath) || (h.args.length === 1 && ic.isFormerScript(h.args[0], 'abito-recap-hook.cjs'))),
  previewNotes: () => ['Recap was removed from Koda: this only takes its old hooks out. Your other hooks are not touched.'],
  postNotes: () => [],
};

function runRecapInstall(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.includes('--timeout-sec') || !argv.includes('--remove')) {
    (opts.err || (s => process.stderr.write(s)))(USAGE);
    return Promise.resolve(64);
  }
  return ic.runInstall(['recap', ...argv], { ...opts, profile: PROFILE, binPath: opts.binPath || RECAP_BIN });
}

module.exports = { runRecapInstall, RECAP_BIN, PROFILE, USAGE };

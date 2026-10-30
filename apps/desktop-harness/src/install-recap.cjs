'use strict';
// Installer for the notify-only recap hooks (UserPromptSubmit, PostToolUse, Stop) of Claude Code (#467 T10 slice 5).
// A profile of install-claude.cjs: same preview/dated backup/typed-word apply/marker-only removal, byte-exact patch
// of the "hooks" member only. The hooks never answer a permission and never block (src/recap-hook.cjs).
const path = require('node:path');
const ic = require('./install-claude.cjs');

const RECAP_BIN = path.resolve(__dirname, '../bin/abito-recap-hook.cjs');
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const TIMEOUT_SEC = 5;
const USAGE = 'usage: abito-hook install recap (--settings <abs path> | --user) [--remove] [--apply]\n';

const PROFILE = {
  name: 'recap',
  defaultFile: ['.claude', 'settings.json'],
  events: EVENTS,
  defaultTimeoutSec: TIMEOUT_SEC,
  usage: USAGE,
  checkPaths: () => {},
  buildEntry: (_event, timeoutSec, binPath, execPath) => ({ type: 'command', command: execPath, args: [binPath], timeout: timeoutSec }),
  isOurs: (h, binPath) => ic.isObj(h) && h.type === 'command' && Array.isArray(h.args) && (h.args.includes(binPath) || (h.args.length === 1 && ic.isFormerScript(h.args[0], 'abito-recap-hook.cjs'))),
  previewNotes: () => ['Notify-only: these hooks only count activity (prompts, tool kinds, lines changed) for the weekly recap. No command text, path or prompt is kept.'],
  postNotes: () => [],
};

function runRecapInstall(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.includes('--timeout-sec')) {
    (opts.err || (s => process.stderr.write(s)))(USAGE);
    return Promise.resolve(64);
  }
  return ic.runInstall(['recap', ...argv], { ...opts, profile: PROFILE, binPath: opts.binPath || RECAP_BIN });
}

module.exports = { runRecapInstall, RECAP_BIN, PROFILE, USAGE };

'use strict';
// Copilot CLI installer. Copilot loads every `*.json` in ~/.copilot/hooks/, so Abito owns ONE file there (abito-island.json) and
// never edits settings.json or anybody else's file. Same safety model as install-claude.cjs: preview, backup of an existing file,
// previewed plan hash for the island's trusted click, post-write verification with automatic restore, symlink/owner refusals.
// Copilot hook entries are flat (`{type, exec, args, timeoutSec}` under `hooks.<event>`), so this module builds its own plan but
// hands core.applyPlan the same plan shape (a one-patch whole-file replacement).
const path = require('node:path');
const core = require('./install-claude.cjs');

const EVENT = 'permissionRequest', END = 'sessionEnd';
const EVENTS = [EVENT, END];
const USAGE = 'usage: abito-hook install copilot (--settings <abs path to a hooks .json> | --user) [--timeout-sec N] [--remove] [--apply]\n';
const refuse = m => new core.InstallError(65, 'refused: ' + m);
const isAbsPlain = p => typeof p === 'string' && p !== '' && !/[\0\n\r]/.test(p) && path.isAbsolute(p);

const buildEntries = (timeoutSec, binPath, execPath) => ({
  [EVENT]: { type: 'command', exec: execPath, args: [binPath, 'copilot', 'permission-request', '--timeout-sec', String(timeoutSec)], timeoutSec },
  [END]: { type: 'command', exec: execPath, args: [binPath, 'copilot', 'stop'], timeoutSec: 15 },
});
// Ours = our node + our script + the copilot subcommand of that event.
const SUB = { [EVENT]: 'permission-request', [END]: 'stop' };
const isOursFor = event => (h, binPath, execPath) => core.isObj(h) && h.type === 'command' && h.exec === execPath && Array.isArray(h.args)
  && h.args[0] === binPath && h.args[1] === 'copilot' && h.args[2] === SUB[event];
const isOurs = (h, binPath, execPath) => EVENTS.some(e => isOursFor(e)(h, binPath, execPath));

const COPILOT_PROFILE = {
  name: 'copilot', defaultFile: ['.copilot', 'hooks', 'abito-island.json'], events: EVENTS, defaultTimeoutSec: 35, usage: USAGE,
  isOurs, checkPaths: (binPath, execPath) => { if (!isAbsPlain(binPath) || !isAbsPlain(execPath)) throw refuse('hook script and node paths must be absolute'); },
  previewNotes: plan => plan.remove ? [] : [`Target hooks file (Koda owns it): ${plan.settingsPath}`,
    'Copilot CLI loads it at startup. An island `allow` skips the Copilot permission prompt for lossless requests; anything else, or no answer, leaves the prompt to Copilot. sessionEnd only sends a notice.'],
  postNotes: () => [],
  verify: plan => (parsed, _p, text) => {
    const has = e => { const l = parsed && parsed.hooks && parsed.hooks[e]; return Array.isArray(l) && l.some(h => isOursFor(e)(h, plan.binPath, plan.execPath)); };
    return EVENTS.every(e => has(e) === !plan.remove) && text === plan.after && JSON.stringify(parsed) === JSON.stringify(plan.planned);
  },
};

function planCopilotHooks({ settingsPath, timeoutSec, remove = false, binPath = core.BIN_PATH, execPath = process.execPath, uid = require('./win-fs.cjs').uidOf(), profile = COPILOT_PROFILE }) {
  if (timeoutSec === undefined) timeoutSec = profile.defaultTimeoutSec;
  core.checkTimeout(timeoutSec);
  profile.checkPaths(binPath, execPath);
  core.checkSettingsSyntax(settingsPath);
  core.checkParent(settingsPath, uid);
  const cur = core.readTarget(settingsPath, uid);
  const before = cur ? cur.buf.toString('utf8') : '';
  let doc = { version: 1, hooks: {} };
  if (cur) {
    try { doc = JSON.parse(before); } catch { throw refuse('hooks file is not valid JSON'); }
    if (!core.isObj(doc) || doc.version !== 1 || (doc.hooks !== undefined && !core.isObj(doc.hooks))) throw refuse('hooks file is not a version 1 Copilot hooks file');
    if (doc.hooks === undefined) doc.hooks = {};
    for (const e of EVENTS) if (doc.hooks[e] !== undefined && !Array.isArray(doc.hooks[e])) throw refuse('unexpected type for hooks.' + e);
  }
  const entries = buildEntries(timeoutSec, binPath, execPath);
  const planned = { ...doc, hooks: { ...doc.hooks } };
  const actions = [];
  for (const e of EVENTS) {
    const list = doc.hooks[e] || [];
    const others = list.filter(h => !isOurs(h, binPath, execPath));
    const ours = list.filter(h => isOursFor(e)(h, binPath, execPath));
    let action;
    if (remove) {
      action = list.length === list.filter(h => !isOursFor(e)(h, binPath, execPath)).length ? 'unchanged' : 'remove';
      const kept = list.filter(h => !isOursFor(e)(h, binPath, execPath));
      if (kept.length) planned.hooks[e] = kept; else delete planned.hooks[e];
    } else {
      const mine = list.filter(h => isOursFor(e)(h, binPath, execPath));
      action = ours.length === 0 ? 'add' : (mine.length === 1 && ours.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entries[e]) ? 'unchanged' : 'replace');
      if (action !== 'unchanged') planned.hooks[e] = [...list.filter(h => !isOursFor(e)(h, binPath, execPath)), entries[e]];
    }
    actions.push({ event: e, action });
  }
  const changed = actions.some(a => a.action !== 'unchanged') || (!cur && !remove);
  const after = changed ? JSON.stringify(planned, null, 2) + '\n' : before;
  return { profile, settingsPath, exists: !!cur, remove, timeoutSec, binPath, execPath, uid, before, baseText: before, after, changed,
    patch: changed ? { start: 0, end: before.length, text: after } : null, actions,
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, planned, entries: EVENTS.map(e => entries[e]) };
}
const runInstallCopilot = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: COPILOT_PROFILE, plan: planCopilotHooks });

module.exports = { COPILOT_PROFILE, USAGE, planCopilotHooks, runInstallCopilot };

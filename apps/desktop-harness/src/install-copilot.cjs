'use strict';
// Copilot CLI installer. Copilot loads every `*.json` in ~/.copilot/hooks/, so Koda owns ONE file there (koda-island.json) and
// never edits settings.json or anybody else's file. Same safety model as install-claude.cjs: preview, backup of an existing file,
// previewed plan hash for the island's trusted click, post-write verification with automatic restore, symlink/owner refusals.
// Copilot hook entries are flat (`{type, exec, args, timeoutSec}` under `hooks.<event>`), so this module builds its own plan but
// hands core.applyPlan the same plan shape (a one-patch whole-file replacement).
const path = require('node:path');
const core = require('./install-claude.cjs');

const EVENT = 'permissionRequest', END = 'sessionEnd';
const EVENTS = [EVENT, END];
const FILE = 'koda-island.json';
// K2-04 (S2, S4): the 0.1 hooks file lived at this name in the same folder. Copilot would load BOTH (two cards per notice), so
// installing the new one retires it: renamed to a dated `.abito-backup-` name, restored if the write fails.
const LEGACY_FILE = 'abito-island.json';
const USAGE = 'usage: koda-hook install copilot (--settings <abs path to a hooks .json> | --user) [--timeout-sec N] [--remove] [--apply]\n';
const refuse = m => new core.InstallError(65, 'refused: ' + m);
const isAbsPlain = p => typeof p === 'string' && p !== '' && !/[\0\n\r]/.test(p) && path.isAbsolute(p);

const buildEntries = (timeoutSec, binPath, execPath) => ({
  [EVENT]: { type: 'command', exec: execPath, args: [binPath, 'copilot', 'permission-request', '--timeout-sec', String(timeoutSec)], timeoutSec },
  [END]: { type: 'command', exec: execPath, args: [binPath, 'copilot', 'stop'], timeoutSec: 15 },
});
// Ours = our node + our script (current name, a former location or a Koda 0.1 name, anchored on the exact basename) + the
// copilot subcommand of that event. `my-abito-hook.cjs` is foreign.
const SUB = { [EVENT]: 'permission-request', [END]: 'stop' };
const ourScript = (p, binPath) => typeof p === 'string' && (p === binPath || core.isHookScript(p));
const isOursFor = event => (h, binPath, execPath) => core.isObj(h) && h.type === 'command' && h.exec === execPath && Array.isArray(h.args)
  && ourScript(h.args[0], binPath) && h.args[1] === 'copilot' && h.args[2] === SUB[event];
const isOurs = (h, binPath, execPath) => EVENTS.some(e => isOursFor(e)(h, binPath, execPath));
/** Our entries stripped out of a 0.1 doc: `after` is the file without them, `null` when only our own stub would be left. */
function withoutOurs(doc, binPath, execPath) {
  const hooks = {};
  let found = false;
  for (const [event, list] of Object.entries(doc.hooks)) {
    if (!Array.isArray(list)) return { found: false }; // unexpected shape: not ours to rewrite
    const kept = list.filter(h => !isOurs(h, binPath, execPath));
    if (kept.length !== list.length) found = true;
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!found) return { found: false };
  const next = { ...doc };
  if (Object.keys(hooks).length > 0) next.hooks = hooks; else delete next.hooks;
  const onlyStub = Object.keys(next).every(k => k === 'version' && next[k] === 1);
  return { found: true, after: onlyStub ? null : `${JSON.stringify(next, null, 2)}\n` };
}
/** The 0.1 file at its old default name in the same folder, when it holds entries of ours. */
function retireTargets(settingsPath, uid, binPath, execPath) {
  if (path.basename(settingsPath) !== FILE) return [];
  const legacy = path.join(path.dirname(settingsPath), LEGACY_FILE);
  const cur = core.readTarget(legacy, uid);
  if (!cur) return [];
  const text = cur.buf.toString('utf8');
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  if (!core.isObj(doc) || !core.isObj(doc.hooks)) return [];
  const stripped = withoutOurs(doc, binPath, execPath);
  if (!stripped.found) return [];
  return [{ abs: legacy, before: text, after: stripped.after, mode: cur.mode }];
}

const COPILOT_PROFILE = {
  name: 'copilot', defaultFile: ['.copilot', 'hooks', FILE], events: EVENTS, defaultTimeoutSec: 35, usage: USAGE,
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
  const retire = retireTargets(settingsPath, uid, binPath, execPath);
  const after = changed ? JSON.stringify(planned, null, 2) + '\n' : before;
  return { profile, settingsPath, exists: !!cur, remove, timeoutSec, binPath, execPath, uid, before, baseText: before, after,
    changed: changed || retire.length > 0, retire,
    patch: changed ? { start: 0, end: before.length, text: after } : null, actions,
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, planned, entries: EVENTS.map(e => entries[e]) };
}
const runInstallCopilot = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: COPILOT_PROFILE, plan: planCopilotHooks });

module.exports = { COPILOT_PROFILE, USAGE, FILE, LEGACY_FILE, withoutOurs, retireTargets, planCopilotHooks, runInstallCopilot };

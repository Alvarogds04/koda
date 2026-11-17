'use strict';
// OpenCode installer: Koda owns ONE plugin file (~/.config/opencode/plugins/koda-island.js); opencode.json is never touched.
// Same safety model as install-claude.cjs (preview, backup, plan hash, verify + restore, symlink/owner refusals). A file that does not
// start with our ownership marker is refused, never overwritten. `remove` leaves an inert stub of ours (the shared apply core writes
// files; it does not delete them).
const path = require('node:path');
const core = require('./install-claude.cjs');

const MARKER = '// koda-island-managed: opencode-plugin/1\n';
// K2-04 (S2, S4): the 0.1 plugin carried this marker and this file name. Both are recognised as OURS — the file at the new name is
// replaced in place when it holds the old marker, and a 0.1 file left at the old name in the same folder is retired (two plugins
// would give two cards per notice). A file without either marker stays foreign, exactly as before.
const LEGACY_MARKER = '// abito-island-managed: opencode-plugin/1\n';
const FILE = 'koda-island.js';
const LEGACY_FILE = 'abito-island.js';
const isManaged = text => text.startsWith(MARKER) || text.startsWith(LEGACY_MARKER);
const USAGE = 'usage: koda-hook install opencode (--settings <abs path to the plugin .js> | --user) [--timeout-sec N] [--remove] [--apply]\n';
const refuse = m => new core.InstallError(65, 'refused: ' + m);
const isAbsPlain = p => typeof p === 'string' && p !== '' && !/[\0\n\r]/.test(p) && path.isAbsolute(p);

// The shim. It never throws into OpenCode, kills the hook at its own deadline, and copies ONLY an exact allow|deny.
function renderPlugin({ execPath, binPath, timeoutSec }) {
  if (!isAbsPlain(execPath) || !isAbsPlain(binPath)) throw refuse('hook script and node paths must be absolute');
  core.checkTimeout(timeoutSec);
  return MARKER + `import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(execPath)};
const BIN = ${JSON.stringify(binPath)};
const TIMEOUT_SEC = ${timeoutSec};

function decide(request, sub = "permission-request") {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child;
    try {
      child = spawn(NODE, [BIN, "opencode", sub, ...(sub === "stop" ? [] : ["--timeout-sec", String(TIMEOUT_SEC)])], { stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(null); }, TIMEOUT_SEC * 1000);
    child.on("error", () => finish(null));
    child.stdout.on("data", (c) => { if (out.length < 256) out += c; });
    child.on("close", () => {
      try { const s = JSON.parse(out).status; finish(s === "allow" || s === "deny" ? s : null); } catch { finish(null); }
    });
    child.stdin.on("error", () => {});
    try { child.stdin.end(JSON.stringify(request)); } catch { finish(null); }
  });
}

export const AbitoIslandPlugin = async (ctx) => ({
  "permission.ask": async (input, output) => {
    try {
      const meta = input && input.metadata && JSON.stringify(input.metadata).length < 32000 ? input.metadata : {};
      const status = await decide({ sessionID: input && input.sessionID, directory: (ctx && ctx.directory) || process.cwd(), type: input && input.type, title: input && input.title, pattern: input && input.pattern, metadata: meta });
      if (status) output.status = status;
    } catch {}
  },
  event: async ({ event }) => {
    try {
      if (event && event.type === "session.idle") {
        const id = event.properties && (event.properties.sessionID || (event.properties.info && event.properties.info.id));
        if (typeof id === "string") await decide({ sessionID: id, directory: (ctx && ctx.directory) || process.cwd() }, "stop");
      }
    } catch {}
  },
});
`;
}
const STUB = MARKER + 'export const AbitoIslandPlugin = async () => ({});\n';

const OPENCODE_PROFILE = {
  name: 'opencode', defaultFile: ['.config', 'opencode', 'plugins', FILE], events: ['permission.ask', 'event'], defaultTimeoutSec: 35, usage: USAGE,
  rawText: true, isOurs: () => false,
  checkPaths: (binPath, execPath) => { if (!isAbsPlain(binPath) || !isAbsPlain(execPath)) throw refuse('hook script and node paths must be absolute'); },
  previewNotes: plan => plan.remove ? ['Remove leaves an inert stub plugin; delete the file by hand to drop it entirely.'] : [`Plugin file (Koda owns it): ${plan.settingsPath}`,
    'OpenCode loads it at startup. permission.ask is wired per OpenCode version: if yours ignores it, its own prompt keeps working. Questions from the question tool are not covered.'],
  postNotes: () => [],
  verify: plan => (_parsed, _p, text) => text === plan.after,
};

/** The 0.1 plugin at its old default name in the same folder, when it exists and carries our (old or new) marker. */
function retireTargets(settingsPath, uid) {
  if (path.basename(settingsPath) !== FILE) return [];
  const legacy = path.join(path.dirname(settingsPath), LEGACY_FILE);
  const cur = core.readTarget(legacy, uid);
  if (!cur) return [];
  const text = cur.buf.toString('utf8');
  return isManaged(text) ? [{ abs: legacy, before: text, after: null, mode: cur.mode }] : [];
}

function planOpencodePlugin({ settingsPath, timeoutSec, remove = false, binPath = core.BIN_PATH, execPath = process.execPath, uid = require('./win-fs.cjs').uidOf(), profile = OPENCODE_PROFILE }) {
  if (timeoutSec === undefined) timeoutSec = profile.defaultTimeoutSec;
  core.checkTimeout(timeoutSec);
  profile.checkPaths(binPath, execPath);
  core.checkSettingsSyntax(settingsPath);
  core.checkParent(settingsPath, uid);
  const cur = core.readTarget(settingsPath, uid);
  const before = cur ? cur.buf.toString('utf8') : '';
  if (cur && !isManaged(before)) throw refuse('the plugin file exists and is not managed by Koda');
  const after = remove ? STUB : renderPlugin({ execPath, binPath, timeoutSec });
  const changed = cur ? before !== after : !remove;
  const action = !changed ? 'unchanged' : remove ? 'remove' : cur ? 'replace' : 'add';
  const retire = retireTargets(settingsPath, uid);
  return { profile, settingsPath, exists: !!cur, remove, timeoutSec, binPath, execPath, uid, before, baseText: before, after: changed ? after : before,
    changed: changed || retire.length > 0, retire,
    patch: changed ? { start: 0, end: before.length, text: after } : null, actions: [{ event: 'permission.ask', action }, { event: 'event', action }],
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, planned: {}, entries: [{ file: path.basename(settingsPath) }] };
}
const runInstallOpencode = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: OPENCODE_PROFILE, plan: planOpencodePlugin });

module.exports = { OPENCODE_PROFILE, USAGE, MARKER, LEGACY_MARKER, FILE, LEGACY_FILE, STUB, renderPlugin, isManaged, retireTargets, planOpencodePlugin, runInstallOpencode };

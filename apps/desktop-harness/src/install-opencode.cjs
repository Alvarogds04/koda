'use strict';
// OpenCode installer: Abito owns ONE plugin file (~/.config/opencode/plugins/abito-island.js); opencode.json is never touched.
// Same safety model as install-claude.cjs (preview, backup, plan hash, verify + restore, symlink/owner refusals). A file that does not
// start with our ownership marker is refused, never overwritten. `remove` leaves an inert stub of ours (the shared apply core writes
// files; it does not delete them).
const path = require('node:path');
const core = require('./install-claude.cjs');

const MARKER = '// abito-island-managed: opencode-plugin/1\n';
const USAGE = 'usage: abito-hook install opencode (--settings <abs path to the plugin .js> | --user) [--timeout-sec N] [--remove] [--apply]\n';
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
  name: 'opencode', defaultFile: ['.config', 'opencode', 'plugins', 'abito-island.js'], events: ['permission.ask', 'event'], defaultTimeoutSec: 35, usage: USAGE,
  rawText: true, isOurs: () => false,
  checkPaths: (binPath, execPath) => { if (!isAbsPlain(binPath) || !isAbsPlain(execPath)) throw refuse('hook script and node paths must be absolute'); },
  previewNotes: plan => plan.remove ? ['Remove leaves an inert stub plugin; delete the file by hand to drop it entirely.'] : [`Plugin file (Koda owns it): ${plan.settingsPath}`,
    'OpenCode loads it at startup. permission.ask is wired per OpenCode version: if yours ignores it, its own prompt keeps working. Questions from the question tool are not covered.'],
  postNotes: () => [],
  verify: plan => (_parsed, _p, text) => text === plan.after,
};

function planOpencodePlugin({ settingsPath, timeoutSec, remove = false, binPath = core.BIN_PATH, execPath = process.execPath, uid = require('./win-fs.cjs').uidOf(), profile = OPENCODE_PROFILE }) {
  if (timeoutSec === undefined) timeoutSec = profile.defaultTimeoutSec;
  core.checkTimeout(timeoutSec);
  profile.checkPaths(binPath, execPath);
  core.checkSettingsSyntax(settingsPath);
  core.checkParent(settingsPath, uid);
  const cur = core.readTarget(settingsPath, uid);
  const before = cur ? cur.buf.toString('utf8') : '';
  if (cur && !before.startsWith(MARKER)) throw refuse('the plugin file exists and is not managed by Koda');
  const after = remove ? STUB : renderPlugin({ execPath, binPath, timeoutSec });
  const changed = cur ? before !== after : !remove;
  const action = !changed ? 'unchanged' : remove ? 'remove' : cur ? 'replace' : 'add';
  return { profile, settingsPath, exists: !!cur, remove, timeoutSec, binPath, execPath, uid, before, baseText: before, after: changed ? after : before, changed,
    patch: changed ? { start: 0, end: before.length, text: after } : null, actions: [{ event: 'permission.ask', action }, { event: 'event', action }],
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, planned: {}, entries: [{ file: path.basename(settingsPath) }] };
}
const runInstallOpencode = (argv, opts = {}) => core.runInstall(argv, { ...opts, profile: OPENCODE_PROFILE, plan: planOpencodePlugin });

module.exports = { OPENCODE_PROFILE, USAGE, MARKER, STUB, renderPlugin, planOpencodePlugin, runInstallOpencode };

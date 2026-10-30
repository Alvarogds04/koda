'use strict';
// Island install mode: machine-readable preview (--json) and trusted-click apply (--apply-plan <hash>).
// No TTY and no typed word: the confirmation is the click in the island, which only passes a plan_hash it previewed.
// This module is a thin layer over the shared planner/apply core in install-claude.cjs (no behavior change there).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./install-claude.cjs');
const winfs = require('./win-fs.cjs');
const codex = require('./install-codex.cjs');
const recap = require('./install-recap.cjs');
const statusline = require('./install-statusline.cjs');
const copilot = require('./install-copilot.cjs');
const opencode = require('./install-opencode.cjs');
const pi = require('./install-pi.cjs');

const INSTALLER_VERSION = 'abito-hook-installer/1';
const SCHEMA = 'abito-hook-install/1';
const HARNESSES = ['claude', 'codex', 'copilot', 'opencode', 'recap', 'statusline', 'pi'];
const AUDIT_FILE = 'hook-installs.jsonl';
const DIFF_MAX_LINES = 200;
const DIFF_MAX_LINE_LEN = 300;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
const AUDIT_MAX_BYTES = 1024 * 1024;
const BACKUP_SUFFIX_MAX = 9;
// Best-effort list, defence in depth only: NOT a security boundary (a same-uid process can edit the settings file by hand anyway).
const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'AI_AGENT', 'GENTLE_PI_SESSION'];

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const HASH_RE = /^[0-9a-f]{64}$/;

class UiError extends Error {
  constructor(exitCode, code, message) { super(message); this.exitCode = exitCode; this.code = code; }
}

// ---- canonical JSON + plan hash ----
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function computePlanHash(plan, harness, action, version = INSTALLER_VERSION) {
  const doc = {
    schema: SCHEMA, harness, action, target: plan.settingsPath,
    ...(plan.backupRoot ? {backupRoot:plan.backupRoot} : {}),
    original: { exists: plan.exists, sha256: plan.sig ? plan.sig.sha256 : '', size: plan.sig ? plan.sig.size : 0 },
    result_sha256: plan.changed ? sha256(Buffer.from(plan.after, 'utf8')) : '',
    timeoutSec: plan.timeoutSec, execPath: plan.execPath, binPath: plan.binPath, installerVersion: version,
  };
  return sha256(canonical(doc));
}
function hashEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- island guards (exit 77) ----
function defaultReadExe(pid) {
  // Preserve Linux's existing guard exactly; never substitute ps or environment claims for /proc.
  if (process.platform === 'linux') return fs.realpathSync(`/proc/${pid}/exe`);
  const platform = require('./installer-platform.cjs');
  const executable = process.platform === 'darwin' ? platform.darwinParentExecutable(pid)
    : process.platform === 'win32' ? platform.windowsParentExecutable(pid) : undefined;
  // Windows: GetFinalPathNameByHandle canonicalization (long names, no 8.3 aliases) on both sides of the comparison.
  return executable ? (process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync)(executable) : undefined;
}
// The actual parent is the app-owned Node adapter/daemon, not the Tauri executable.
// Canonical executable identity AND no agent marker are required. Non-Linux probes also require own uid/SID.
function checkIslandGuards(env, ppid, readExe = defaultReadExe, platform = process.platform, realpath = platform === 'win32' ? fs.realpathSync.native : fs.realpathSync) {
  try {
    const exe = env.ABITO_ISLAND_EXE;
    const win = platform === 'win32';
    if (typeof exe !== 'string' || exe === '' || !(win ? path.win32 : path).isAbsolute(exe)) return false;
    const mine = realpath(exe), theirs = readExe(ppid);
    // Windows paths are case-insensitive; every other platform compares byte for byte (unchanged).
    if (win ? typeof theirs !== 'string' || mine.toLowerCase() !== theirs.toLowerCase() : mine !== theirs) return false;
  } catch { return false; }
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase(); // case-insensitive: 'claudecode' counts as much as 'CLAUDECODE'
    const marker = AGENT_MARKERS.includes(u) || u === 'OPENCODE' || u.startsWith('OPENCODE_');
    if (marker && typeof env[k] === 'string' && env[k] !== '') return false;
  }
  return true;
}

// ---- audit log ----
function winAuditDir(w, dir, create) {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !path.isAbsolute(dir)) throw new Error('audit dir must be absolute and normalized');
  if (create) w.makeDir(dir);
  const f = w.checkPath(dir);
  if (f.kind !== 'dir' || f.reparse || !f.private || !f.parent_ok) throw new Error('audit dir is not a private directory of ours');
}
function ensureAuditDir(dir, uid, create = true) {
  const w = winfs.active();
  if (w) return winAuditDir(w, dir, create);
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !path.isAbsolute(dir) || path.normalize(dir) !== dir || (dir.length > 1 && dir.endsWith('/'))) throw new Error('audit dir must be absolute and normalized');
  let st;
  try { st = fs.lstatSync(dir); } catch (e) {
    if (e.code !== 'ENOENT' || !create) throw e;
    const parent = fs.lstatSync(path.dirname(dir));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('audit dir parent is not a directory');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('audit dir is not a real directory');
  if (st.uid !== uid) throw new Error('audit dir has a foreign owner');
  if (st.mode & 0o022) throw new Error('audit dir is group/world-writable');
}
// Size cap: past 1 MiB the file moves to <file>.1 (replacing the previous generation), kept 0600. Best effort.
function rotateAudit(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size <= AUDIT_MAX_BYTES) return;
    fs.renameSync(file, file + '.1');
    fs.chmodSync(file + '.1', 0o600);
  } catch { /* best effort: the append below still decides */ }
}
// Appends exactly one JSON line. Throws on any problem (callers decide whether that is fatal).
function winAppendAudit(w, file, record) {
  const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
  for (let attempt = 0; attempt < 5; attempt++) {
    // The helper caps one read/write at 1 MiB, so the size is taken from the helper's facts BEFORE any read: a log that is already
    // past half the cap is rotated (replacing the previous generation) and never read.
    const facts = w.checkPath(file);
    if (facts.exists && facts.size + line.length > AUDIT_MAX_BYTES / 2) {
      try { w.remove(file + '.1'); } catch (e) { if (e.reason !== 'missing' && e.reason !== 'helper_failed') throw e; }
      w.move(file, file + '.1');
    }
    const cur = w.readPrivate(file);
    try { w.writePrivate(file, cur ? Buffer.concat([cur.buf, line]) : line, cur ? cur.sha256 : null); return; }
    catch (e) { if (e.reason !== 'mismatch' && e.reason !== 'exists') throw e; }
  }
  throw new Error('audit file is busy');
}
function appendAudit(dir, record, uid = winfs.uidOf(), { create = true } = {}) {
  ensureAuditDir(dir, uid, create);
  const file = path.join(dir, AUDIT_FILE);
  const w = winfs.active();
  if (w) return winAppendAudit(w, file, record);
  rotateAudit(file);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.nlink !== 1) throw new Error('audit file is not a private regular file');
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    if (fs.writeSync(fd, line) !== line.length) throw new Error('short audit write');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

// ---- apply lock: serializes simultaneous applies on the same target (stale after 30 s) ----
const LOCK_OWNER = 'owner';
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Returns {dir, token}, or null when busy. Throws UiError(65, not_writable) when the settings directory refuses the mkdir.
// The lock is a directory holding an 'owner' file with a random token; a regular file or symlink planted at that path
// (lstat, never followed) is unlinked once older than 30 s and counts as busy while younger.
function winAcquireLock(w, dir, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let made;
    try { made = w.makeDir(dir); } catch (e) {
      if (e.reason === 'not_private' || e.reason === 'reparse' || e.reason === 'unsafe_path') throw new UiError(65, 'not_writable', 'the settings directory is not private to this user; nothing was written');
      return null;
    }
    if (made.created) {
      const token = crypto.randomBytes(16).toString('hex');
      try { w.writePrivate(path.join(dir, LOCK_OWNER), Buffer.from(token), null); } catch { try { w.remove(dir); } catch { /* ignore */ } return null; }
      return { dir, token };
    }
    try {
      const f = w.checkPath(dir);
      if (Date.now() - f.mtime_ms > LOCK_STALE_MS) { try { w.remove(path.join(dir, LOCK_OWNER)); } catch { /* ignore */ } w.remove(dir); continue; }
    } catch { /* raced with the owner: retry */ }
    if (Date.now() > deadline) return null;
    sleepMs(25);
  }
}
function acquireLock(target, waitMs = LOCK_WAIT_MS) {
  const dir = path.join(path.dirname(target), `.${path.basename(target)}.abito-lock`);
  const w = winfs.active();
  if (w) return winAcquireLock(w, dir, waitMs);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      const token = crypto.randomBytes(16).toString('hex');
      try { fs.writeFileSync(path.join(dir, LOCK_OWNER), token, { mode: 0o600, flag: 'wx' }); } catch { try { fs.rmdirSync(dir); } catch { /* ignore */ } return null; }
      return { dir, token };
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw new UiError(65, 'not_writable', 'the settings directory is not writable; nothing was written');
      if (e.code !== 'EEXIST') return null;
      try {
        const st = fs.lstatSync(dir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          if (st.isDirectory()) { try { fs.unlinkSync(path.join(dir, LOCK_OWNER)); } catch { /* ignore */ } fs.rmdirSync(dir); } else fs.unlinkSync(dir);
          continue;
        }
      } catch { /* raced with the owner: retry */ }
      if (Date.now() > deadline) return null;
      sleepMs(25);
    }
  }
}
// Removes the lock only if it still carries OUR token: a stolen/replaced lock belongs to someone else now.
function releaseLock(lock) {
  const w = winfs.active();
  if (w) {
    try { const own = w.readPrivate(path.join(lock.dir, LOCK_OWNER)); if (own && own.buf.toString('utf8') === lock.token) { w.remove(path.join(lock.dir, LOCK_OWNER)); w.remove(lock.dir); } } catch { /* best effort */ }
    return;
  }
  try {
    if (fs.readFileSync(path.join(lock.dir, LOCK_OWNER), 'utf8') !== lock.token) return;
    fs.unlinkSync(path.join(lock.dir, LOCK_OWNER));
    fs.rmdirSync(lock.dir);
  } catch { /* best effort */ }
}
// Free backup name: the TTY name when free, else -1..-9 (lstat: a dangling symlink counts as taken). The apply itself stays O_EXCL.
function freeBackupPath(settingsPath, when) {
  const baseName = core.backupPathFor(settingsPath, when);
  for (let i = 0; i <= BACKUP_SUFFIX_MAX; i++) {
    const cand = i === 0 ? baseName : `${baseName}-${i}`;
    const w = winfs.active();
    if (w) { try { if (!w.checkPath(cand).exists) return cand; } catch { return baseName; } continue; }
    try { fs.lstatSync(cand); } catch (e) { if (e.code === 'ENOENT') return cand; return baseName; }
  }
  return baseName; // all taken: the O_EXCL write fails => apply_failed, nothing overwritten
}

// ---- args ----
function parseUiArgs(argv) {
  if (!Array.isArray(argv) || !HARNESSES.includes(argv[0])) return null;
  const harness = argv[0];
  const rest = [harness];
  let json = false, applyPlan = null, auditDir = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { if (json) return null; json = true; }
    else if (a === '--apply-plan') { if (applyPlan !== null || i + 1 >= argv.length || !HASH_RE.test(argv[i + 1])) return null; applyPlan = argv[++i]; }
    else if (a === '--audit-dir') { if (auditDir !== null || i + 1 >= argv.length) return null; auditDir = argv[++i]; }
    else if (a === '--settings' || a === '--timeout-sec') { rest.push(a); if (i + 1 < argv.length) rest.push(argv[++i]); }
    else rest.push(a);
  }
  const o = core.parseInstallArgs(rest, harness);
  if (!o || o.apply) return null;
  if (harness === 'pi' && (!o.user || o.timeoutSec !== null)) return null;
  if (['recap', 'statusline'].includes(harness) && o.timeoutSec !== null) return null;
  if (applyPlan !== null && (!json || auditDir === null)) return null;
  if (applyPlan === null && auditDir !== null) return null;
  return { harness, o, json, applyPlan, auditDir };
}

// ---- JSON view of a plan ----
const OP = { add: 'add', replace: 'replace', remove: 'remove', unchanged: 'keep' };
const entriesOf = plan => plan.actions.map(a => ({ event: a.event, op: OP[a.action] || 'keep' }));
const cleanLine = l => l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').slice(0, DIFF_MAX_LINE_LEN);
function diffView(plan) {
  if (!plan.changed) return { lines: [], hidden: 0, outside_hooks_changed_lines: 0 };
  let lines = core.diffLines(plan.before, plan.after), hidden = 0;
  const last = lines[lines.length - 1], m = /^\.\.\. diff truncated: ([0-9]+) more lines hidden$/.exec(last || '');
  if (m) { hidden = Number(m[1]); lines = lines.slice(0, -1); }
  if (lines.length > DIFF_MAX_LINES) { hidden += lines.length - DIFF_MAX_LINES; lines = lines.slice(0, DIFF_MAX_LINES); }
  return { lines: lines.map(cleanLine), hidden, outside_hooks_changed_lines: core.changedOutsidePatch(plan) };
}
const NOTES_BASE = [
  'Preview only: nothing was written.',
  'The backup path is planned; the timestamp is chosen when the plan is applied.',
  'Applying requires the plan_hash of this preview and fails with plan_changed if anything differs.',
];
const NOTE_TRUST = 'Codex keeps these hooks inactive until the human reviews them in /hooks; this installer never touches config.toml.';

function buildPlan(parsed, opts) {
  const profile = parsed.harness === 'codex' ? codex.CODEX_PROFILE : parsed.harness === 'copilot' ? copilot.COPILOT_PROFILE : parsed.harness === 'opencode' ? opencode.OPENCODE_PROFILE : parsed.harness === 'recap' ? recap.PROFILE : core.CLAUDE_PROFILE;
  const env = opts.env || process.env;
  const o = parsed.o;
  if (parsed.harness === 'pi') {
    const target = core.resolveUserSettings(env, opts.homedir || os.homedir, ['.pi', 'agent', 'extensions', 'abito-island']);
    const plan = pi.planPi({home:env.HOME, uid:opts.uid === undefined ? winfs.uidOf() : opts.uid, remove:o.remove,
      execPath:opts.execPath || process.execPath, binPath:opts.binPath || core.BIN_PATH});
    if (plan.settingsPath !== target) throw new core.InstallError(65, 'Pi default path mismatch');
    const action = o.remove ? 'remove' : 'install';
    return {plan, action, hash:computePlanHash(plan, parsed.harness, action), trust:false};
  }
  const settingsPath = o.user ? core.resolveUserSettings(env, opts.homedir || os.homedir, profile.defaultFile) : o.settings;
  const common = {
    settingsPath, remove: o.remove, execPath: opts.execPath || process.execPath,
    uid: opts.uid === undefined ? winfs.uidOf() : opts.uid,
  };
  const plan = parsed.harness === 'statusline'
    ? statusline.planStatusLine({ ...common, binPath: opts.binPath || statusline.STATUSLINE_BIN, home: o.user ? env.HOME : (opts.homedir || os.homedir)() })
    : ({ copilot: copilot.planCopilotHooks, opencode: opencode.planOpencodePlugin }[parsed.harness] || core.planClaudeSettings)({ ...common, timeoutSec: o.timeoutSec === null ? profile.defaultTimeoutSec : o.timeoutSec, profile,
      binPath: opts.binPath || (parsed.harness === 'recap' ? recap.RECAP_BIN : core.BIN_PATH) });
  const action = o.remove ? 'remove' : 'install';
  return { plan, action, hash: computePlanHash(plan, parsed.harness, action), trust: parsed.harness === 'codex' && !o.remove };
}

const WIN_UNVERIFIED = new Set(['helper_failed', 'helper_untrusted', 'script_untrusted']);
// Helper reasons that are not a privacy/link problem: the plan went stale, or the filesystem was busy/failed (HU-047 L7).
const WIN_STALE = new Set(['mismatch', 'exists', 'missing']);
const WIN_FAILED = new Set(['busy', 'io', 'too_large']);
function winFailure(reason, fail) {
  if (WIN_UNVERIFIED.has(reason)) return fail(65, 'install_unverified', fixedMessage.unverified);
  if (WIN_STALE.has(reason)) return fail(70, 'plan_changed', 'the settings changed since the previewed plan; nothing was written');
  if (WIN_FAILED.has(reason)) return fail(70, 'apply_failed', 'the plan could not be applied');
  return fail(65, 'unsafe_target', fixedMessage.unsafe);
}
const shellArg = d => /^[A-Za-z0-9_@%+=:,./-]+$/.test(d) ? d : "'" + d.replace(/'/g, "'\\''") + "'";
// HU-047: one sentence per reason, always naming the exact folder; chmod only where chmod can fix it.
function unsafeFolderMessage({ dir, reason }) {
  if (reason === 'writable') return `La carpeta ${dir} la puede modificar otro usuario o grupo; quitale el permiso de escritura (chmod g-w,o-w ${shellArg(dir)}) y volvé a intentar.`;
  if (reason === 'foreign_owner') return `La carpeta ${dir} pertenece a otro usuario y Koda solo escribe en carpetas tuyas; cambiale el dueño a tu usuario (con permisos de administrador) y volvé a intentar.`;
  return `La carpeta ${dir} tiene permisos de Windows (ACL) que dan acceso a otros usuarios o no es tuya; dejala accesible solo para tu usuario (Propiedades > Seguridad) y volvé a intentar.`;
}
const fixedMessage = { foreignExtension: 'Ya hay una extensión de Pi en ~/.pi/agent/extensions/abito-island que Koda no instaló: borrala o renombrala y volvé a conectar.', unverified: 'the installed Koda files could not be verified; nothing was written', unsafe: 'the target or its folder is not private to this user or goes through a link; nothing was written', usage: 'invalid arguments', refused: 'input or settings file refused', internal: 'unexpected failure; nothing was written' };

// argv: arguments after `install`. Always prints exactly one JSON line through opts.out; returns the exit code.
async function runInstallUi(argv, opts = {}) {
  const out = opts.out || (s => process.stdout.write(s));
  let emitted = false;
  const emit = obj => {
    if (typeof opts.onJson === 'function') opts.onJson(obj); // the caller learns the verdict before the (fallible) write
    if (emitted) return;
    emitted = true;
    try { out(JSON.stringify(obj) + '\n'); } catch { /* a closed stdout must not turn into a second line */ }
  };
  let refuseHash;
  const fail = (exit, code, message, extra) => {
    if (refuseHash !== undefined && code !== 'audit_unavailable') {
      try { appendAudit(opts.auditDir, { ts: Date.now(), event: 'refused', code, plan_hash: refuseHash }, opts.uid === undefined ? winfs.uidOf() : opts.uid, { create: false }); } catch { /* never blocks, never changes the exit */ }
    }
    emit({ schema: SCHEMA, ok: false, code, message, ...(extra || {}) }); return exit;
  };
  try {
    const parsed = parseUiArgs(argv);
    if (!parsed) return fail(64, 'usage', fixedMessage.usage);
    // Windows (HU-047): audit, side files, locks and every write go through the native ACL helper, which must match the
    // install manifest. If it cannot be trusted the plan is refused up front and nothing is read or written.
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) return fail(77, 'unsupported_platform', 'Automatic hook installation is not available on this platform yet.');
    if (process.platform === 'win32') {
      try { winfs.active(); } catch { return fail(65, 'install_unverified', fixedMessage.unverified); }
    }
    if (parsed.applyPlan !== null) { refuseHash = parsed.applyPlan; opts = { ...opts, auditDir: parsed.auditDir }; }
    if (parsed.applyPlan === null) {
      const { plan, action, hash, trust } = buildPlan(parsed, opts);
      const backupPath = plan.changed && plan.exists ? core.backupPathFor(plan.backupTarget || plan.settingsPath, (opts.now || (() => new Date()))()) : null;
      const notes = [...NOTES_BASE]; if (trust) notes.push(NOTE_TRUST);
      emit({
        schema: SCHEMA, ok: true, mode: 'preview', harness: parsed.harness, action, target: plan.settingsPath, exists: plan.exists, changed: plan.changed,
        entries: entriesOf(plan), backup_path: backupPath, diff: diffView(plan), requires_trust_review: trust, plan_hash: hash, notes,
      });
      return 0;
    }
    return await applyPlanned(parsed, opts, emit, fail);
  } catch (e) {
    if (e instanceof UiError) return fail(e.exitCode, e.code, e.message);
    if (e instanceof core.InstallError && e.unsafeFolder) return fail(65, 'unsafe_folder', unsafeFolderMessage(e.unsafeFolder), { folder: e.unsafeFolder.dir, folder_reason: e.unsafeFolder.reason });
    if (e instanceof winfs.WinFsError) return winFailure(e.reason, fail);
    if (e instanceof core.InstallError && e.foreignExtension) return fail(65, 'foreign_extension', fixedMessage.foreignExtension);
    if (e instanceof core.InstallError && e.reason) return winFailure(e.reason, fail);
    if (e instanceof core.InstallError) return e.exitCode === 64 ? fail(64, 'usage', fixedMessage.usage) : fail(e.exitCode, 'refused', fixedMessage.refused);
    return fail(70, 'internal', fixedMessage.internal);
  }
}

async function applyPlanned(parsed, opts, emit, fail) {
  const env = opts.env || process.env;
  const uid = opts.uid === undefined ? winfs.uidOf() : opts.uid;
  const now = opts.now || (() => new Date());
  // 1) island guards first: nothing is read or written before they pass
  if (!checkIslandGuards(env, opts.ppid === undefined ? process.ppid : opts.ppid, opts.readExe)) return fail(77, 'not_island', 'not allowed in this context');
  // 2) recompute from scratch and compare in constant time (cheap pre-check, then again under the lock)
  const first = buildPlan(parsed, opts);
  if (!hashEqual(first.hash, parsed.applyPlan)) return fail(70, 'plan_changed', 'the settings or arguments differ from the previewed plan; nothing was written');
  const lock = acquireLock(first.plan.lockTarget || first.plan.settingsPath, opts.lockWaitMs === undefined ? LOCK_WAIT_MS : opts.lockWaitMs);
  if (!lock) return fail(70, 'busy', 'another apply is in progress; nothing was written');
  try {
    const { plan, action, hash, trust } = buildPlan(parsed, opts);
    if (!hashEqual(hash, parsed.applyPlan)) return fail(70, 'plan_changed', 'the settings or arguments differ from the previewed plan; nothing was written');
    // 3) audit first, fail closed
    try {
      appendAudit(parsed.auditDir, { ts: Date.now(), event: 'intent', harness: parsed.harness, action, target: plan.settingsPath, plan_hash: hash }, uid);
    } catch { return fail(73, 'audit_unavailable', 'audit trail unavailable; nothing was written'); }
    // 4) apply with the shared machinery, no TTY and no prompt
    let rc = 0, code = plan.changed ? 'applied' : 'noop', backupPath = null;
    if (plan.changed) {
      backupPath = plan.exists ? freeBackupPath(plan.backupTarget || plan.settingsPath, now()) : null;
      let msg = '', previousSaved = false;
      if (parsed.harness === 'statusline' && plan.savePrevious) {
        try { statusline.writeSaved(plan.home, plan.savePrevious); previousSaved = true; }
        catch { rc = 70; }
      }
      if (rc === 0) rc = await (parsed.harness === 'pi' ? pi.applyPi : core.applyPlan)(plan, { backupPath,
        verify: parsed.harness === 'statusline' ? statusline.verify(plan) : (plan.profile && plan.profile.verify ? plan.profile.verify(plan) : undefined),
        out: () => {}, err: s => { msg += s; } });
      if (parsed.harness === 'statusline' && ((rc !== 0 && previousSaved) || (rc === 0 && plan.restorePrevious))) {
        try { statusline.removePrevious(plan.home); } catch { /* same cleanup as the interactive installer */ }
      }
      if (rc !== 0) code = /changed since the preview/.test(msg) ? 'plan_changed' : /could not restore/.test(msg) ? 'restore_failed' : /verification failed/.test(msg) ? 'verification_failed' : 'apply_failed';
    }
    const backupMade = backupPath !== null && (winfs.active() ? (() => { try { return winfs.active().checkPath(backupPath).exists; } catch { return false; } })() : fs.existsSync(backupPath)) ? backupPath : null;
    // 5) result line, best effort
    let recorded = true;
    try { appendAudit(parsed.auditDir, { ts: Date.now(), event: 'result', plan_hash: hash, ok: rc === 0, code, backup: backupMade }, uid); } catch { recorded = false; }
    if (rc !== 0) {
      const o = { schema: SCHEMA, ok: false, code, message: code === 'restore_failed' ? 'verification failed and the original could not be restored automatically' : 'the plan could not be applied' };
      if (!recorded) o.audit = 'result_not_recorded';
      emit(o);
      return 70;
    }
    // 6) one JSON line
    const rollback = parsed.harness === 'pi' || !plan.changed || winfs.active() ? null : backupMade ? `cp -p ${core.shq(backupMade)} ${core.shq(plan.settingsPath)}` : `rm -- ${core.shq(plan.settingsPath)}`;
    const res = {
      schema: SCHEMA, ok: true, mode: 'applied', harness: parsed.harness, action, target: plan.settingsPath, plan_hash: hash, changed: plan.changed,
      backup: backupMade, rollback, entries: entriesOf(plan), requires_trust_review: trust,
    };
    if (!recorded) res.audit = 'result_not_recorded';
    emit(res);
    return 0;
  } finally { releaseLock(lock); }
}

module.exports = { acquireLock, releaseLock, INSTALLER_VERSION, SCHEMA, AGENT_MARKERS, AUDIT_FILE, canonical, computePlanHash, checkIslandGuards, appendAudit, parseUiArgs, runInstallUi, unsafeFolderMessage };

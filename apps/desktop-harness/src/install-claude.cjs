'use strict';
// Installer for the Claude Code hooks: preview (default), backup, human confirmation.
// It only ever touches the settings path it is given (explicit --settings <abs path> or --user typed by the human).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const winfs = require('./win-fs.cjs');

const BIN_PATH = path.resolve(__dirname, '../bin/abito-hook.cjs');
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 35;
const STOP_TIMEOUT_SEC = 15;
const DIFF_LINES = 200;
const EVENTS = ['PermissionRequest', 'SessionStart', 'Stop'];
// S2: AskUserQuestion fires PermissionRequest too, so ONE handler with no matcher answers permissions and
// questions alike (dispatch by tool_name inside src/claude.cjs). The old PreToolUse/AskUserQuestion entry is no
// longer installed; an existing install is MIGRATED by deleting exactly the entry we own there (never a foreign one).
const MIGRATIONS = ['PreToolUse'];
const SESSION_START_TIMEOUT_SEC = 5;
// Matcher group each event is installed under (Claude hooks are `{matcher?, hooks:[...]}` groups). None of our events
// needs one: PermissionRequest without a matcher sees every tool, AskUserQuestion included.
const CLAUDE_MATCHERS = {};
const CLAUDE_PROFILE = {
  name: 'claude',
  defaultFile: ['.claude', 'settings.json'],
  events: EVENTS,
  migrations: MIGRATIONS,
  matchers: CLAUDE_MATCHERS,
  defaultTimeoutSec: DEFAULT_TIMEOUT_SEC,
  usage: null, // set below
  checkPaths: () => {},
  buildEntry: (event, timeoutSec, binPath, execPath) => {
    if (event === 'Stop') return { type: 'command', command: execPath, args: [binPath, 'claude', 'stop'], timeout: STOP_TIMEOUT_SEC };
    if (event === 'SessionStart') return { type: 'command', command: execPath, args: [binPath, 'claude', 'session-start'], timeout: SESSION_START_TIMEOUT_SEC };
    return { type: 'command', command: execPath, args: [binPath, 'claude', 'permission-request', '--timeout-sec', String(timeoutSec)], timeout: timeoutSec };
  },
  // HU-068: ours = the current script OR the same Abito script from a FORMER location (AppTranslocation, Downloads, an old install
  // dir), anchored on the exact file name as args[0] and the `claude` subcommand as args[1]. A look-alike name is foreign.
  isOurs: (h, binPath) => isObjF(h) && h.type === 'command' && Array.isArray(h.args) && h.args.includes('claude')
    && (h.args.includes(binPath) || (h.args[1] === 'claude' && isFormerScript(h.args[0], 'abito-hook.cjs'))),
  previewNotes: plan => (plan.actions.some(a => a.migrated && a.action !== 'unchanged')
    ? ['Migration: the Koda-owned PreToolUse (AskUserQuestion) entry is removed; AskUserQuestion is answered under PermissionRequest now, next to the terminal dialog.']
    : []),
  postNotes: () => [],
};
/** True when `p` is a path (either separator style) whose last component is exactly `name`. */
function isFormerScript(p, name) {
  if (typeof p !== 'string' || p.includes('\0')) return false;
  const parts = p.split(/[\\/]/);
  return parts.length > 1 && parts[parts.length - 1] === name;
}
function isObjF(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const USAGE = 'usage: abito-hook install claude (--settings <abs path> | --user) [--timeout-sec N] [--remove] [--apply]\n';

CLAUDE_PROFILE.usage = USAGE;

class InstallError extends Error {
  constructor(exitCode, message) { super(message); this.exitCode = exitCode; }
}
const refuse = m => new InstallError(65, 'refused: ' + m);
// HU-047: a folder that is the problem (another user/group can change it, it is not ours, its Windows ACL is not private).
// Carries the exact folder and a reason so every surface can name it; never used for links (those keep the generic refusal).
function unsafeFolder(dir, reason) {
  const WHY = { foreign_owner: 'settings directory is not owned by the current user', writable: 'settings directory is writable by other users', acl: 'settings directory is not private to the current user' };
  const e = refuse(WHY[reason] || 'settings directory is unsafe');
  e.unsafeFolder = { dir, reason };
  return e;
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function checkTimeout(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3600) throw new InstallError(64, 'timeout-sec must be an integer 1..3600');
  return n;
}

// ---- paths (syntax only, no filesystem) ----
function checkSettingsSyntax(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw refuse('settings path invalid');
  if (!path.isAbsolute(p)) throw refuse('settings path must be absolute');
  if (path.normalize(p) !== p || p.endsWith('/')) throw refuse('settings path must be normalized');
  for (const bad of ['/proc', '/sys', '/dev']) if (p === bad || p.startsWith(bad + '/')) throw refuse('settings path under a system directory');
  return p;
}
function resolveUserSettings(env, homedir = os.homedir, file = CLAUDE_PROFILE.defaultFile) {
  const home = env && env.HOME;
  if (typeof home !== 'string' || home === '' || !path.isAbsolute(home) || path.normalize(home) !== home) {
    throw new InstallError(64, 'HOME must be set to an absolute normalized path for --user');
  }
  const resolved = homedir();
  if (resolved !== home) throw new InstallError(64, 'HOME does not match the resolved home directory');
  return path.join(home, ...file);
}
function checkParent(settingsPath, uid) {
  const w = winfs.active();
  if (w) return winCheckParent(w, settingsPath);
  const dir = path.dirname(settingsPath);
  let st, real;
  try { st = fs.lstatSync(dir); real = fs.realpathSync(dir); } catch { throw refuse('settings directory does not exist'); }
  if (st.isSymbolicLink() || real !== dir) throw refuse('settings directory path contains a symlink');
  if (!st.isDirectory()) throw refuse('settings directory is not a directory');
  if (st.uid !== uid) throw unsafeFolder(dir, 'foreign_owner');
  if (st.mode & 0o002) throw unsafeFolder(dir, 'writable');
}

// ---- Windows (HU-047): the native helper decides owner/DACL/reparse; Node only reads and refuses ----
const WIN_WHY = { not_private: 'is not private to the current user', reparse: 'goes through a link or junction', too_large: 'is too large', unsafe_path: 'has an unsafe path',
  exists: 'already exists', missing: 'is missing', mismatch: 'changed since the preview', io: 'could not be accessed', helper_failed: 'could not be verified', helper_untrusted: 'could not be verified' };
function winRefuse(e, what) {
  if (e instanceof InstallError) return e;
  const reason = e && e.reason;
  const err = refuse(`${what} ${WIN_WHY[reason] || 'could not be verified'}`);
  err.reason = reason || 'helper_failed';
  return err;
}
function winCheckParent(w, settingsPath) {
  let f;
  try { f = w.checkPath(settingsPath); } catch (e) { throw winRefuse(e, 'settings directory'); }
  if (!f.parent_ok) { const err = unsafeFolder(path.dirname(settingsPath), 'acl'); err.reason = 'not_private'; throw err; }
}
function winReadTarget(w, settingsPath) {
  let got;
  try { got = w.readPrivate(settingsPath); } catch (e) { throw winRefuse(e, 'settings file'); }
  if (got === null) return null;
  if (!Buffer.from(got.buf.toString('utf8'), 'utf8').equals(got.buf)) throw refuse('settings file is not valid UTF-8');
  return { buf: got.buf, sig: { size: got.size, mtimeMs: got.mtimeMs, sha256: got.sha256 }, mode: 0o600 };
}

// ---- reading ----
function readTarget(settingsPath, uid) {
  const w = winfs.active();
  if (w) return winReadTarget(w, settingsPath);
  let lst;
  try { lst = fs.lstatSync(settingsPath); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw refuse('cannot stat settings file');
  }
  if (lst.isSymbolicLink()) throw refuse('settings file is a symlink');
  if (!lst.isFile()) throw refuse('settings file is not a regular file');
  let fd;
  try {
    fd = fs.openSync(settingsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse('settings file is not a regular file');
    if (st.uid !== uid) throw refuse('settings file is not owned by the current user');
    if (st.size > MAX_BYTES) throw refuse('settings file is too large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = fs.readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    if (off !== buf.length) throw refuse('settings file changed while reading');
    if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) throw refuse('settings file is not valid UTF-8');
    return { buf, sig: { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(buf) }, mode: st.mode & 0o777 };
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw refuse('cannot read settings file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function detectIndent(text) {
  const m = /^([ \t]+)\S/m.exec(text);
  if (!m) return 2;
  if (m[1][0] === '\t') return '\t';
  return m[1].length === 4 ? 4 : 2;
}


// ---- strict JSON scanner (no dependencies): byte spans only, never re-serializes ----
const MAX_DEPTH = 200;
const NUM_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
function scanSettings(text) {
  const n = text.length;
  let i = 0;
  const numbers = [], dups = [];
  const bad = () => { throw refuse('settings file is not strict JSON'); };
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const str = () => {
    const s = i; i++;
    for (;;) {
      if (i >= n) bad();
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return [s, i]; }
      if (c < 0x20) bad();
      if (c === 92) {
        i++;
        const e = text[i];
        if (e !== undefined && '"\\/bfnrt'.includes(e)) i++;
        else if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) bad(); i += 5; } else bad();
      } else i++;
    }
  };
  const value = depth => {
    if (depth > MAX_DEPTH) throw refuse('settings file is nested too deeply');
    if (i >= n) bad();
    const c = text[i];
    if (c === '"') { str(); return null; }
    if (c === '{') return object(depth);
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return null; }
      for (;;) {
        ws(); value(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return null; }
        bad();
      }
    }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return null; }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(text);
    if (!m) bad();
    numbers.push([i, i + m[0].length]); i += m[0].length;
    return null;
  };
  const object = depth => {
    const open = i; i++; ws();
    const members = [], seen = new Set();
    if (text[i] === '}') { i++; return { open, close: i - 1, members }; }
    for (;;) {
      ws();
      if (text[i] !== '"') bad();
      const [ks, ke] = str();
      let key;
      try { key = JSON.parse(text.slice(ks, ke)); } catch { bad(); }
      if (seen.has(key)) dups.push(ks);
      seen.add(key);
      ws(); if (text[i] !== ':') bad(); i++; ws();
      const vs = i; value(depth + 1); const ve = i;
      members.push({ key, start: ks, keyEnd: ke, valStart: vs, valEnd: ve, end: ve });
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return { open, close: i - 1, members }; }
      bad();
    }
  };
  ws();
  if (i >= n) bad();
  const first = text[i];
  const top = value(0);
  ws();
  if (i !== n) bad();
  if (first !== '{') throw refuse('settings file is not a JSON object');
  return { ...top, numbers, dups };
}

function canonNumber(tok) {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(tok);
  if (!m) return null;
  let digits = m[2] + (m[3] || ''), exp = Number(m[4] || 0) - (m[3] || '').length;
  digits = digits.replace(/^0+/, '');
  if (digits === '') return '0';
  const trimmed = digits.replace(/0+$/, '');
  exp += digits.length - trimmed.length;
  return m[1] + trimmed + 'e' + exp;
}
function numberIsLossless(tok) {
  const v = Number(tok);
  if (!Number.isFinite(v)) return false;
  if (v === 0 && tok[0] === '-') return false;
  if (/^-?[0-9]+$/.test(tok)) return Number.isSafeInteger(v);
  const a = canonNumber(tok), b = canonNumber(String(v));
  return a !== null && a === b;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120000;
function promptTimeoutFromEnv(env) {
  const raw = env && env.ABITO_INSTALL_PROMPT_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw)) return DEFAULT_PROMPT_TIMEOUT_MS;
  return Math.min(600000, Math.max(100, Number(raw)));
}
// One-line prompt helper: resolves ONCE with the first line (before closing, so close cannot win); EOF/error/timeout without a line => ''.
// `state.timedOut` is set when the absolute timeout fired.
function askLine(input, output, question, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, state = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output });
    let settled = false;
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { state.timedOut = true; done(''); try { rl.close(); } catch { /* ignore */ } }, timeoutMs);
    rl.once('close', () => done(''));
    input.once('end', () => done(''));
    input.on('error', () => done(''));
    rl.on('error', () => done(''));
    rl.question(question, a => { done(a); rl.close(); });
  });
}

// style of the file: eol, member indent string (null when compact), indent unit for JSON.stringify
function detectStyle(text, top) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let mi = null;
  for (const m of top.members) {
    let j = m.start;
    while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--;
    if (j === 0 || text[j - 1] === '\n') { mi = text.slice(j, m.start); break; }
  }
  let unit;
  if (mi && mi[0] === '\t') unit = '\t';
  else if (mi && mi.length > 0) unit = Math.min(mi.length, 10);
  else unit = detectIndent(text);
  return { eol, mi: mi === null ? (unit === '\t' ? '\t' : ' '.repeat(unit)) : mi, compact: mi === null, unit };
}

// ---- planning ----
function applyEvent(obj, event, entry, remove, binPath, isOurs, execPath, matcher) {
  let hooks = obj.hooks;
  if (hooks !== undefined && !isObj(hooks)) throw refuse('unexpected type for hooks');
  const present = hooks !== undefined && hooks[event] !== undefined;
  if (present && !Array.isArray(hooks[event])) throw refuse('unexpected type for hooks.' + event);
  const groups = present ? hooks[event] : [];
  let first = true, found = 0, action = 'unchanged';
  const kept = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const hs = [];
    let touched = false;
    for (const h of g.hooks) {
      if (!isOurs(h, binPath, execPath)) { hs.push(h); continue; }
      found++; touched = true;
      if (remove) continue;
      if (first) { first = false; hs.push(entry); if (JSON.stringify(h) !== JSON.stringify(entry)) action = 'replace'; }
      else action = 'replace'; // duplicate of ours dropped
    }
    if (!touched) { kept.push(g); continue; }
    if (hs.length === 0) continue; // matcher group emptied by us
    kept.push({ ...g, hooks: hs });
  }
  if (remove) {
    if (found === 0) return 'unchanged';
    if (kept.length === 0) { delete hooks[event]; if (Object.keys(hooks).length === 0) delete obj.hooks; } else hooks[event] = kept;
    return 'remove';
  }
  if (found === 0) {
    if (hooks === undefined) { hooks = obj.hooks = {}; }
    hooks[event] = [...kept, matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] }];
    return 'add';
  }
  hooks[event] = kept;
  return action;
}

function buildPatch(base, top, member, newHooks, style) {
  const ser = v => JSON.stringify(v, null, style.unit).replace(/\n/g, style.eol + style.mi);
  if (member) {
    if (newHooks !== undefined) return { start: member.valStart, end: member.valEnd, text: ser(newHooks) };
    const idx = top.members.indexOf(member);
    if (top.members.length === 1) return { start: top.open + 1, end: top.close, text: '' };
    if (idx < top.members.length - 1) return { start: member.start, end: top.members[idx + 1].start, text: '' };
    return { start: top.members[idx - 1].end, end: member.end, text: '' };
  }
  const entry = `"hooks": ${ser(newHooks)}`;
  const last = top.members[top.members.length - 1];
  const at = last ? last.end : top.open + 1;
  const tailHasNewline = base.slice(at, top.close).includes('\n');
  return { start: at, end: at, text: (last ? ',' : '') + style.eol + style.mi + entry + (tailHasNewline ? '' : style.eol) };
}

function planClaudeSettings({ settingsPath, timeoutSec, remove = false, binPath = BIN_PATH, execPath = process.execPath, uid = winfs.uidOf(), profile = CLAUDE_PROFILE }) {
  if (timeoutSec === undefined) timeoutSec = profile.defaultTimeoutSec;
  const EVENTS = profile.events;
  const plannedEntry = (event, t, b, x) => profile.buildEntry(event, t, b, x);
  checkTimeout(timeoutSec);
  profile.checkPaths(binPath, execPath);
  checkSettingsSyntax(settingsPath);
  checkParent(settingsPath, uid);
  const cur = readTarget(settingsPath, uid);
  const text = cur ? cur.buf.toString('utf8') : '';
  const baseText = cur ? text : '{}\n';
  const top = scanSettings(baseText);
  const hm = top.members.filter(m => m.key === 'hooks');
  if (hm.length > 1) throw refuse('settings file has duplicate top-level "hooks" keys');
  const member = hm[0] || null;
  const wrapper = {};
  if (member) {
    if (top.dups.some(p => p >= member.valStart && p < member.valEnd)) throw refuse('hooks contains duplicate keys; re-serializing would alter your data');
    for (const [s, e] of top.numbers) {
      if (s >= member.valStart && e <= member.valEnd && !numberIsLossless(baseText.slice(s, e))) throw refuse('hooks contains a number that cannot be re-serialized losslessly');
    }
    wrapper.hooks = JSON.parse(baseText.slice(member.valStart, member.valEnd));
  }
  const style = detectStyle(baseText, top);
  const actions = EVENTS.map(event => ({ event, action: applyEvent(wrapper, event, plannedEntry(event, timeoutSec, binPath, execPath), remove, binPath, profile.isOurs, execPath, (profile.matchers || {})[event]) }));
  // Migration: delete our own entries from events we no longer install. Removal only, so it is a no-op on a clean file
  // and idempotent afterwards. A migration that had nothing to remove is not reported (the preview then only shows
  // the events we own), but one that did remove something always is, install and uninstall alike.
  for (const event of profile.migrations || []) {
    const action = applyEvent(wrapper, event, null, true, binPath, profile.isOurs, execPath);
    if (action !== 'unchanged') actions.push({ event, action, migrated: true });
  }
  const changed = actions.some(a => a.action !== 'unchanged');
  const patch = changed ? buildPatch(baseText, top, member, wrapper.hooks, style) : null;
  const after = changed ? baseText.slice(0, patch.start) + patch.text + baseText.slice(patch.end) : text;
  return {
    profile, settingsPath, exists: !!cur, remove, timeoutSec, binPath, execPath, uid, before: text, baseText, patch, after, changed, actions,
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, planned: wrapper,
    entries: EVENTS.map(e => plannedEntry(e, timeoutSec, binPath, execPath)),
  };
}

// ---- preview ----
function diffLines(a, b) {
  const x = a === '' ? [] : a.split('\n'), y = b === '' ? [] : b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const ctx = 3, from = Math.max(0, s - ctx);
  const out = [`@@ -${from + 1} +${from + 1} @@`];
  for (let i = from; i < s; i++) out.push(' ' + x[i]);
  for (let i = s; i < x.length - e; i++) out.push('-' + x[i]);
  for (let i = s; i < y.length - e; i++) out.push('+' + y[i]);
  for (let i = x.length - e; i < Math.min(x.length, x.length - e + ctx); i++) out.push(' ' + x[i]);
  if (out.length > DIFF_LINES) { const n = out.length - DIFF_LINES; out.length = DIFF_LINES; out.push(`... diff truncated: ${n} more lines hidden`); }
  return out;
}
// lines that differ between before and after outside the patched span (must be 0 by construction; computed, not assumed)
function changedOutsidePatch(plan) {
  const p = plan.patch;
  if (!p) return 0;
  const a = plan.baseText, b = plan.after;
  const pre = a.slice(0, p.start) === b.slice(0, p.start) ? 0 : a.slice(0, p.start).split('\n').length;
  const tail = a.length - p.end;
  const suf = a.slice(p.end) === b.slice(b.length - tail) ? 0 : a.slice(p.end).split('\n').length;
  return pre + suf;
}
function backupPathFor(settingsPath, now) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${settingsPath}.abito-backup-${ts}`;
}
function renderPreview(plan, { backupPath, apply }) {
  const L = [];
  L.push(`Target: ${plan.settingsPath}`);
  L.push(`File exists: ${plan.exists ? 'yes' : 'no (the file would be created, mode 0600)'}`);
  L.push('Settings directory: must already exist; it is never created (--user refuses with exit 65 otherwise)');
  L.push(`Operation: ${plan.remove ? 'remove' : 'install'} Koda hook entries`);
  for (const n of plan.profile.previewNotes(plan)) L.push(n);
  for (const a of plan.actions) L.push(`  hooks.${a.event}: ${a.action}`);
  if (!plan.remove) for (const e of plan.entries) L.push(`  entry: ${JSON.stringify(e)}`);
  if (plan.changed) {
    L.push(plan.exists ? `Backup that would be created: ${backupPath}` : 'No backup (the file does not exist yet).');
    L.push('Diff:'); L.push(...diffLines(plan.before, plan.after));
    L.push(`Lines changed outside hooks: ${changedOutsidePatch(plan)}`);
  } else L.push('Nothing to change.');
  if (!apply) L.push('dry run: nothing was written');
  return L.join('\n') + '\n';
}

// ---- apply ----
function sameSig(settingsPath, plan) {
  const cur = readTarget(settingsPath, plan.uid);
  if (!plan.sig) return cur === null;
  return cur !== null && cur.sig.size === plan.sig.size && cur.sig.mtimeMs === plan.sig.mtimeMs && cur.sig.sha256 === plan.sig.sha256;
}
function writeNew(file, data, mode) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function tempPath(settingsPath) {
  return path.join(path.dirname(settingsPath), `.${path.basename(settingsPath)}.abito-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}
function defaultVerify(parsed, plan, text) {
  const EVENTS = plan.profile.events, isOurs = plan.profile.isOurs;
  const has = ev => { const g = parsed && parsed.hooks && parsed.hooks[ev]; return Array.isArray(g) && g.some(x => isObj(x) && Array.isArray(x.hooks) && x.hooks.some(h => isOurs(h, plan.binPath, plan.execPath))); };
  if (!EVENTS.every(ev => has(ev) === !plan.remove)) return false;
  for (const ev of plan.profile.migrations || []) if (has(ev)) return false; // the migrated-away entry must be gone
  if (!parsed || JSON.stringify(parsed.hooks) !== JSON.stringify(plan.planned.hooks)) return false;
  const p = plan.patch;
  if (typeof text !== 'string' || !p) return false;
  const prefix = plan.baseText.slice(0, p.start), suffix = plan.baseText.slice(p.end);
  return text.length === prefix.length + p.text.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix) && text === plan.after;
}
function restore(plan, backupPath) {
  const w = winfs.active();
  if (w) {
    try {
      const cur = w.readPrivate(plan.settingsPath);
      if (backupPath) { w.writePrivate(plan.settingsPath, w.readPrivate(backupPath).buf, cur ? cur.sha256 : null); } else if (cur) w.remove(plan.settingsPath);
      return true;
    } catch { return false; }
  }
  try {
    if (backupPath) {
      const tmpf = tempPath(plan.settingsPath);
      try { writeNew(tmpf, fs.readFileSync(backupPath), plan.mode); fs.renameSync(tmpf, plan.settingsPath); } catch (e) { try { fs.unlinkSync(tmpf); } catch { /* ignore */ } throw e; }
    } else fs.unlinkSync(plan.settingsPath);
    return true;
  } catch { return false; }
}

async function applyPlan(plan, { backupPath, verify = defaultVerify, out, err }) {
  const w = winfs.active();
  if (w) return winApplyPlan(w, plan, { backupPath, verify, out, err });
  const target = plan.settingsPath;
  const data = Buffer.from(plan.after, 'utf8');
  if (plan.patch && plan.exists) {
    const orig = fs.readFileSync(target);
    const pre = Buffer.from(plan.baseText.slice(0, plan.patch.start), 'utf8'), suf = Buffer.from(plan.baseText.slice(plan.patch.end), 'utf8');
    const mid = Buffer.from(plan.patch.text, 'utf8');
    const okBytes = data.length === pre.length + mid.length + suf.length && orig.subarray(0, pre.length).equals(pre) && orig.subarray(orig.length - suf.length).equals(suf)
      && data.subarray(0, pre.length).equals(orig.subarray(0, pre.length)) && data.subarray(data.length - suf.length).equals(orig.subarray(orig.length - suf.length))
      && data.subarray(pre.length, pre.length + mid.length).equals(mid);
    if (!okBytes) { err('refused: bytes outside the hooks span would change; nothing was written\n'); return 70; }
  }
  const wantHash = sha256(data);
  if (!sameSig(target, plan)) { err('refused: settings file changed since the preview; nothing was written\n'); return 70; }
  let backupMade = false, tmpf = null;
  try {
    if (plan.exists) { writeNew(backupPath, plan.before === '' ? Buffer.alloc(0) : fs.readFileSync(target), 0o600); backupMade = true; }
    tmpf = tempPath(target);
    writeNew(tmpf, data, plan.mode);
    if (sha256(fs.readFileSync(tmpf)) !== wantHash) throw new Error('temp content mismatch');
    if (!sameSig(target, plan)) { fs.unlinkSync(tmpf); tmpf = null; err('refused: settings file changed since the preview; nothing was written\n'); return 70; }
    if (plan.exists) fs.renameSync(tmpf, target);
    else { fs.linkSync(tmpf, target); fs.unlinkSync(tmpf); }
    tmpf = null;
  } catch {
    if (tmpf) { try { fs.unlinkSync(tmpf); } catch { /* ignore */ } }
    err('error: could not write settings; target unchanged\n');
    return 70;
  }
  let ok = false;
  try { const written = fs.readFileSync(target, 'utf8'); ok = !!verify(plan.profile && plan.profile.rawText ? null : JSON.parse(written), plan, written); } catch { ok = false; }
  if (!ok) {
    const restored = restore(plan, backupMade ? backupPath : null);
    if (restored) err('error: verification failed; the previous settings were restored\n');
    else if (backupMade) err(`error: verification failed; could not restore automatically; your original is at ${backupPath}\n`);
    else err(`error: verification failed; could not restore automatically; remove the new file ${target} by hand\n`);
    return 70;
  }
  out(`Done. ${plan.remove ? 'Removed' : 'Installed'} Koda hook entries in ${target}\n`);
  if (backupMade) { out(`Backup: ${backupPath}\nRollback: cp -p ${shq(backupPath)} ${shq(target)}\n`); }
  else out(`Rollback: rm -- ${shq(target)}\n`);
  for (const n of plan.profile.postNotes(plan)) out(n + '\n');
  return 0;
}

async function winApplyPlan(w, plan, { backupPath, verify, out, err }) {
  const target = plan.settingsPath;
  const data = Buffer.from(plan.after, 'utf8');
  const stale = () => { err('refused: settings file changed since the preview; nothing was written\n'); return 70; };
  if (plan.patch && plan.exists) {
    const orig = Buffer.from(plan.before, 'utf8');
    const pre = Buffer.from(plan.baseText.slice(0, plan.patch.start), 'utf8'), suf = Buffer.from(plan.baseText.slice(plan.patch.end), 'utf8');
    if (!(data.subarray(0, pre.length).equals(orig.subarray(0, pre.length)) && data.subarray(data.length - suf.length).equals(orig.subarray(orig.length - suf.length)))) {
      err('refused: bytes outside the hooks span would change; nothing was written\n'); return 70;
    }
  }
  let backupMade = false;
  try {
    const cur = winReadTarget(w, target);
    if ((plan.sig ? cur === null || cur.sig.sha256 !== plan.sig.sha256 : cur !== null)) return stale();
    if (plan.exists) { w.writePrivate(backupPath, cur.buf, null); backupMade = true; }
    // The helper re-checks the expected hash under the same call that replaces the file.
    w.writePrivate(target, data, plan.exists ? plan.sig.sha256 : null);
  } catch (e) {
    if (e && e.reason === 'mismatch') return stale();
    err(`error: could not write settings (${(e && e.reason) || 'unverified'}); target unchanged\n`);
    return 70;
  }
  let ok = false;
  try { const written = w.readPrivate(target).buf.toString('utf8'); ok = !!verify(plan.profile && plan.profile.rawText ? null : JSON.parse(written), plan, written); } catch { ok = false; }
  if (!ok) {
    const restored = restore(plan, backupMade ? backupPath : null);
    if (restored) err('error: verification failed; the previous settings were restored\n');
    else if (backupMade) err(`error: verification failed; could not restore automatically; your original is at ${backupPath}\n`);
    else err(`error: verification failed; could not restore automatically; remove the new file ${target} by hand\n`);
    return 70;
  }
  out(`Done. ${plan.remove ? 'Removed' : 'Installed'} Koda hook entries in ${target}\n`);
  if (backupMade) out(`Backup: ${backupPath}\n`);
  for (const n of plan.profile.postNotes(plan)) out(n + '\n');
  return 0;
}

function parseInstallArgs(argv, name = 'claude') {
  if (!Array.isArray(argv) || argv[0] !== name) return null;
  const o = { settings: null, user: false, timeoutSec: null, remove: false, apply: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--settings') { if (o.settings !== null || i + 1 >= argv.length) return null; o.settings = argv[++i]; if (!path.isAbsolute(o.settings)) return null; }
    else if (a === '--user') { if (o.user) return null; o.user = true; }
    else if (a === '--remove') { if (o.remove) return null; o.remove = true; }
    else if (a === '--apply') { if (o.apply) return null; o.apply = true; }
    else if (a === '--timeout-sec') {
      if (o.timeoutSec !== null || i + 1 >= argv.length || !/^[0-9]{1,4}$/.test(argv[i + 1])) return null;
      o.timeoutSec = Number(argv[++i]);
    } else return null;
  }
  if ((o.settings === null) === !o.user) return null; // exactly one of --settings / --user
  if (o.remove && o.timeoutSec !== null) return null;
  return o;
}

// argv: arguments after `install`. Returns the exit code; all I/O goes through options.
async function runInstall(argv, opts = {}) {
  const out = opts.out || (s => process.stdout.write(s));
  const err = opts.err || (s => process.stderr.write(s));
  const profile = opts.profile || CLAUDE_PROFILE;
  const usage = () => { err(profile.usage); return 64; };
  const o = parseInstallArgs(argv, profile.name);
  if (!o) return usage();
  try {
    const settingsPath = o.user ? resolveUserSettings(opts.env || process.env, opts.homedir || os.homedir, profile.defaultFile) : o.settings;
    if (o.apply) {
      const isTTY = opts.isTTY || (() => !!(process.stdin.isTTY && process.stdout.isTTY));
      if (!isTTY()) { err('refused: --apply needs an interactive terminal on stdin and stdout; nothing was written\n'); return 77; }
    }
    const plan = (opts.plan || planClaudeSettings)({ settingsPath, timeoutSec: o.timeoutSec === null ? profile.defaultTimeoutSec : o.timeoutSec, remove: o.remove, profile,
      binPath: opts.binPath || BIN_PATH, execPath: opts.execPath || process.execPath, uid: opts.uid === undefined ? winfs.uidOf() : opts.uid });
    const now = (opts.now || (() => new Date()))();
    const backupPath = backupPathFor(settingsPath, now);
    out(renderPreview(plan, { backupPath, apply: o.apply }));
    if (!o.apply) return 0;
    if (!plan.changed) return 0;
    const word = o.remove ? 'remove' : 'install';
    const answer = await opts.prompt(`Type exactly "${word}" and press Enter to continue, anything else aborts: `);
    if (answer === '' && opts.timedOut && opts.timedOut()) { err('aborted: confirmation timed out; nothing was written\n'); return 1; }
    if (answer !== word) { err('aborted: confirmation word not typed; nothing was written\n'); return 1; }
    return await applyPlan(plan, { backupPath, verify: opts.verify || (profile.verify ? profile.verify(plan) : undefined), out, err });
  } catch (e) {
    if (e instanceof InstallError) { err(e.message + '\n'); return e.exitCode; }
    err('error: unexpected failure; nothing was written\n');
    return 70;
  }
}

module.exports = { isFormerScript, winRefuse, numberIsLossless, readTarget, checkParent, detectStyle, sameSig, DIFF_LINES, diffLines, changedOutsidePatch, checkTimeout, CLAUDE_PROFILE, InstallErrorRefuse: refuse, unsafeFolder, shq, isObj, askLine, promptTimeoutFromEnv, scanSettings, defaultVerify, BIN_PATH, USAGE, InstallError, planClaudeSettings, renderPreview, runInstall, applyPlan, resolveUserSettings, checkSettingsSyntax, parseInstallArgs, backupPathFor, MAX_BYTES };

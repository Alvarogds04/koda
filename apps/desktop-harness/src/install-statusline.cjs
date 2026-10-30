'use strict';
// Installer for the Claude Code `statusLine` relay (#467 T10 slice 4), same pattern as install-claude.cjs:
// preview by default, dated backup, explicit --apply with a typed word, marker-only removal, byte-exact patch
// of the one top-level "statusLine" member. The user's own status line is saved to ~/.abito/statusline-previous.json
// (0600) and restored on --remove; the relay prints it untouched at run time (src/statusline.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ic = require('./install-claude.cjs');
const winfs = require('./win-fs.cjs');
const { previousShell } = require('./statusline.cjs');

const STATUSLINE_BIN = path.resolve(__dirname, '../bin/abito-statusline.cjs');
const MARKER = 'abito-statusline.cjs';
const USAGE = 'usage: abito-hook install statusline (--settings <abs path> | --user) [--remove] [--apply]\n';
const { InstallError, scanSettings, shq, isObj, diffLines } = ic;
const refuse = ic.InstallErrorRefuse;

const isOurs = v => isObj(v) && typeof v.command === 'string' && v.command.includes(MARKER);
const previousFile = home => path.join(home, '.abito', 'statusline-previous.json');
const removePrevious = home => { const w = winfs.active(); if (w) w.remove(previousFile(home)); else fs.unlinkSync(previousFile(home)); };
const ser = (v, style) => JSON.stringify(v, null, style.unit).replace(/\n/g, style.eol + style.mi);

// The statusLine command for the shell Claude Code will actually run it with (same resolver as the relay's previous-command runner,
// https://code.claude.com/docs/en/statusline «Windows configuration»): Unix /bin/sh single-quoted; Windows Git Bash `"C:/…/node.exe" "C:/…/x.cjs"`
// (forward slashes: bash eats backslashes); Windows PowerShell `& "C:\…\node.exe" "C:\…\x.cjs"` (a leading quoted path is a string expression there).
// HU-047 L6 refusals stay (quote, %, ^, &, |, <, >, control), plus `$` and backtick, which both bash and PowerShell expand inside double quotes.
function statusLineCommand(execPath, binPath, shell) {
  if (!shell) throw refuse('no shell that Claude Code can use was found (Git Bash or PowerShell); nothing was written');
  const q = p => { winfs.quoteWindowsCommandPath(p); if (/[$`]/.test(p)) throw new winfs.WinFsError('unsafe_path', 'unsafe character in a command path'); return p; };
  q(execPath); q(binPath);
  if (/(^|[\\/])bash\.exe$/i.test(shell.file)) { const f = p => `"${p.replace(/\\/g, '/')}"`; return `${f(execPath)} ${f(binPath)}`; }
  return `& "${execPath}" "${binPath}"`;
}

function planStatusLine({ settingsPath, remove = false, execPath = process.execPath, binPath = STATUSLINE_BIN, uid = winfs.uidOf(), home = null, shell }) {
  ic.checkSettingsSyntax(settingsPath);
  ic.checkParent(settingsPath, uid);
  const cur = ic.readTarget(settingsPath, uid);
  const text = cur ? cur.buf.toString('utf8') : '';
  const baseText = cur ? text : '{}\n';
  const top = scanSettings(baseText);
  const ms = top.members.filter(m => m.key === 'statusLine');
  if (ms.length > 1) throw refuse('settings file has duplicate top-level "statusLine" keys');
  const member = ms[0] || null;
  let existing;
  if (member) {
    if (top.dups.some(p => p >= member.valStart && p < member.valEnd)) throw refuse('statusLine contains duplicate keys; re-serializing would alter your data');
    for (const [s, e] of top.numbers) {
      if (s >= member.valStart && e <= member.valEnd && !ic.numberIsLossless(baseText.slice(s, e))) throw refuse('statusLine contains a number that cannot be re-serialized losslessly');
    }
    existing = JSON.parse(baseText.slice(member.valStart, member.valEnd));
    if (!isObj(existing)) throw refuse('unexpected type for statusLine');
  }
  const style = ic.detectStyle(baseText, top);
  const ours = member && isOurs(existing);
  let patch = null, action = 'unchanged', savePrevious = null, restorePrevious = false, value;
  if (!remove) {
    // Windows: Claude Code runs the status line through Git Bash or PowerShell (statusLineCommand); an installed form for the other shell is `replace` => «Desactualizado».
    const command = winfs.active() ? statusLineCommand(execPath, binPath, shell === undefined ? previousShell() : shell) : `${shq(execPath)} ${shq(binPath)}`;
    value = { ...(existing || {}), type: existing && existing.type ? existing.type : 'command', command };
    if (!existing || !ours || existing.command !== command) {
      action = member ? 'replace' : 'add';
      if (member && !ours) savePrevious = { ...existing, abitoRaw: baseText.slice(member.valStart, member.valEnd) };
      patch = member
        ? { start: member.valStart, end: member.valEnd, text: ser(value, style) }
        : addPatch(baseText, top, ser(value, style), style);
    }
  } else if (ours) {
    action = 'remove';
    restorePrevious = true;
    const prev = home ? readSaved(home) : null;
    if (prev) {
      let restored = null;
      if (typeof prev.abitoRaw === 'string') { try { if (isObj(JSON.parse(prev.abitoRaw))) restored = prev.abitoRaw; } catch { /* use the object */ } }
      if (restored === null) { const { abitoRaw, ...rest } = prev; restored = ser(rest, style); }
      patch = { start: member.valStart, end: member.valEnd, text: restored };
    }
    else patch = removePatch(top, member);
  }
  const after = patch ? baseText.slice(0, patch.start) + patch.text + baseText.slice(patch.end) : text;
  return { settingsPath, exists: !!cur, remove, uid, home, before: text, baseText, patch, after, changed: !!patch, action, savePrevious, restorePrevious,
    sig: cur ? cur.sig : null, mode: cur ? cur.mode : 0o600, value,
    profile: { postNotes: () => [], previewNotes: () => [] }, actions: [{ event: 'statusLine', action }], entries: [], binPath, execPath, timeoutSec: null };
}
function readSaved(home) {
  const w = winfs.active();
  if (w) {
    // Windows: owner/DACL/reparse/nlink verdicts come from the native helper; anything unverifiable is treated as absent.
    try {
      const got = w.readPrivate(previousFile(home));
      if (!got || got.size > 64 * 1024) return null;
      const v = JSON.parse(got.buf.toString('utf8'));
      return isObj(v) ? v : null;
    } catch { return null; }
  }
  try {
    const st = fs.lstatSync(previousFile(home));
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(previousFile(home), 'utf8'));
    return isObj(v) ? v : null;
  } catch { return null; }
}
function addPatch(base, top, entryText, style) {
  const entry = `"statusLine": ${entryText}`;
  const last = top.members[top.members.length - 1];
  const at = last ? last.end : top.open + 1;
  const tailHasNewline = base.slice(at, top.close).includes('\n');
  return { start: at, end: at, text: (last ? ',' : '') + style.eol + style.mi + entry + (tailHasNewline ? '' : style.eol) };
}
function removePatch(top, member) {
  const idx = top.members.indexOf(member);
  if (top.members.length === 1) return { start: top.open + 1, end: top.close, text: '' };
  if (idx < top.members.length - 1) return { start: member.start, end: top.members[idx + 1].start, text: '' };
  return { start: top.members[idx - 1].end, end: member.end, text: '' };
}

function render(plan, backupPath, apply) {
  const L = [];
  L.push(`Target: ${plan.settingsPath}`);
  L.push(`File exists: ${plan.exists ? 'yes' : 'no (the file would be created, mode 0600)'}`);
  L.push(`Operation: ${plan.remove ? 'remove' : 'install'} the Koda status line (plan usage). statusLine: ${plan.action}`);
  if (plan.savePrevious) L.push(`Your current status line is saved to ${previousFile(plan.home || '~')} and still runs, unchanged, through the relay.`);
  if (plan.restorePrevious && plan.home && readSaved(plan.home)) L.push('Your saved status line is put back.');
  if (!plan.remove && plan.value) L.push(`  entry: ${JSON.stringify(plan.value)}`);
  if (plan.changed) {
    L.push(plan.exists ? `Backup that would be created: ${backupPath}` : 'No backup (the file does not exist yet).');
    L.push('Diff:'); L.push(...diffLines(plan.before, plan.after));
    L.push(`Lines changed outside statusLine: ${ic.changedOutsidePatch(plan)}`);
  } else L.push('Nothing to change.');
  if (!apply) L.push('dry run: nothing was written');
  return L.join('\n') + '\n';
}

function writeSaved(home, obj) {
  const w = winfs.active();
  if (w) {
    const dir = path.join(home, '.abito'), file = previousFile(home);
    w.makeDir(dir);
    const cur = w.readPrivate(file);
    w.writePrivate(file, Buffer.from(JSON.stringify(obj) + '\n'), cur ? cur.sha256 : null);
    return;
  }
  const dir = path.join(home, '.abito');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = previousFile(home);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function verify(plan) {
  return (parsed, _plan, written) => {
    if (written !== plan.after) return false;
    const sl = parsed && parsed.statusLine;
    return plan.remove ? !isOurs(sl) : isOurs(sl);
  };
}

async function runStatusLineInstall(argv, opts = {}) {
  const out = opts.out || (s => process.stdout.write(s));
  const err = opts.err || (s => process.stderr.write(s));
  const o = parseArgs(argv);
  if (!o) { err(USAGE); return 64; }
  try {
    const env = opts.env || process.env, homedir = opts.homedir || os.homedir;
    const settingsPath = o.user ? ic.resolveUserSettings(env, homedir) : o.settings;
    const home = o.user ? env.HOME : homedir();
    if (o.apply) {
      const isTTY = opts.isTTY || (() => !!(process.stdin.isTTY && process.stdout.isTTY));
      if (!isTTY()) { err('refused: --apply needs an interactive terminal on stdin and stdout; nothing was written\n'); return 77; }
    }
    const plan = planStatusLine({ settingsPath, remove: o.remove, execPath: opts.execPath || process.execPath, binPath: opts.binPath || STATUSLINE_BIN,
      uid: opts.uid === undefined ? winfs.uidOf() : opts.uid, home });
    const now = (opts.now || (() => new Date()))();
    const backupPath = ic.backupPathFor(settingsPath, now);
    out(render(plan, backupPath, o.apply));
    if (!o.apply || !plan.changed) return 0;
    const word = o.remove ? 'remove' : 'install';
    const answer = await opts.prompt(`Type exactly "${word}" and press Enter to continue, anything else aborts: `);
    if (answer !== word) { err('aborted: confirmation word not typed; nothing was written\n'); return 1; }
    if (plan.savePrevious) {
      try { writeSaved(home, plan.savePrevious); } catch { err('error: could not save your current status line; nothing was changed\n'); return 70; }
    }
    const code = await ic.applyPlan(plan, { backupPath, verify: verify(plan), out, err });
    if (code !== 0) {
      if (plan.savePrevious) { try { removePrevious(home); } catch { /* ignore */ } }
      return code;
    }
    if (plan.restorePrevious) { try { removePrevious(home); } catch { /* ignore */ } }
    return 0;
  } catch (e) {
    if (e instanceof InstallError) { err(e.message + '\n'); return e.exitCode; }
    err('error: unexpected failure; nothing was written\n');
    return 70;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) return null;
  const o = { settings: null, user: false, remove: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--settings') { if (o.settings !== null || i + 1 >= argv.length) return null; o.settings = argv[++i]; if (!path.isAbsolute(o.settings)) return null; }
    else if (a === '--user') { if (o.user) return null; o.user = true; }
    else if (a === '--remove') { if (o.remove) return null; o.remove = true; }
    else if (a === '--apply') { if (o.apply) return null; o.apply = true; }
    else return null;
  }
  if ((o.settings === null) === !o.user) return null;
  return o;
}

module.exports = { statusLineCommand, removePrevious, planStatusLine, runStatusLineInstall, STATUSLINE_BIN, isOurs, previousFile, writeSaved, verify, USAGE };

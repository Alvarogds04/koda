'use strict';
// Per-session title cache. Claude Code tells us its session title ONLY in SessionStart (`--name`, /rename); the permission
// and question hooks run later in other processes, so SessionStart stores it here and they read it back to label the island.
// Private (dir 0700, files 0600, owned by us, never a symlink), tiny, best effort: every failure means "no title".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const winfs = require('./win-fs.cjs');

const MAX_FILE_BYTES = 256, MAX_AGE_MS = 14 * 24 * 3600 * 1000;

// The island's wire alphabet for a display name: [A-Za-z0-9._ -]{1,64}. Accents fold to their base letter, the rest becomes `_`.
// A title without a single letter or digit (control junk, bidi marks) is not a title.
function titleName(raw) {
  if (typeof raw !== 'string') return null;
  const folded = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const name = folded.slice(0, 200).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
  return /[A-Za-z0-9]/.test(name) ? name : null;
}

function stateDir(env) {
  const own = env && env.ABITO_STATE_DIR;
  if (typeof own === 'string' && path.isAbsolute(own) && path.normalize(own) === own) return own;
  const xdg = env && env.XDG_STATE_HOME;
  if (typeof xdg === 'string' && path.isAbsolute(xdg) && path.normalize(xdg) === xdg) return path.join(xdg, 'abito-island');
  // Windows: the per-user local app data folder (no `.local/state`); Unix keeps the XDG-style default.
  if (process.platform === 'win32' && env && typeof env.LOCALAPPDATA === 'string' && path.win32.isAbsolute(env.LOCALAPPDATA)) return path.win32.join(env.LOCALAPPDATA, 'Abito', 'state');
  const home = (env && env.HOME) || os.homedir();
  return typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.local', 'state', 'abito-island') : null;
}
const dirOf = (env, kind) => { const base = stateDir(env); return base ? path.join(base, kind) : null; };

// Directories to create under the Windows state root, outermost first (the helper creates one level at a time under a private parent).
function dirChain(dir, env, pathMod = path.win32) {
  const local = env && env.LOCALAPPDATA;
  const norm = typeof local === 'string' && pathMod.isAbsolute(local) ? pathMod.normalize(local).replace(/[\\/]+$/, '') : null;
  const root = norm && dir.toLowerCase().startsWith(norm.toLowerCase() + '\\') ? norm : pathMod.dirname(dir), out = []; // outside LOCALAPPDATA (ABITO_STATE_DIR / XDG) the base must already exist: only the kind folder is created
  for (let d = dir; d !== root && d !== pathMod.dirname(d); d = pathMod.dirname(d)) out.unshift(d);
  return out;
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new Error('not a private directory');
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}
function pruneWin(w, dir, now) {
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (now - fs.lstatSync(p).mtimeMs > MAX_AGE_MS) w.remove(p); } catch { /* best effort */ } } } catch { /* best effort */ }
}
function prune(dir, now) {
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (now - fs.lstatSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p); } catch { /* best effort */ } } } catch { /* best effort */ }
}

// Returns true when a title was stored.
function saveTitle(env, kind, sessionToken, rawTitle, now = Date.now()) {
  try {
    const dir = dirOf(env, kind), name = titleName(rawTitle);
    if (!dir || !name) return false;
    const w = winfs.active();
    const file = path.join(dir, sessionToken);
    if (w) { // Windows (HU-047): the native helper owns directory creation, the private DACL and the write; no uid/mode on this path
      for (const d of dirChain(dir, env, process.platform === 'win32' ? path.win32 : path)) w.makeDir(d);
      pruneWin(w, dir, now);
      if (!w.checkPath(file).parent_ok) return false;
      const cur = w.readPrivate(file);
      w.writePrivate(file, Buffer.from(name), cur ? cur.sha256 : null);
      return true;
    }
    ensurePrivateDir(dir);
    prune(dir, now);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, name, { mode: 0o600, flag: 'w' });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
function loadTitle(env, kind, sessionToken) {
  try {
    const dir = dirOf(env, kind);
    if (!dir) return null;
    const file = path.join(dir, sessionToken);
    const w = winfs.active();
    if (w) { const got = w.readPrivate(file); return got && got.size <= MAX_FILE_BYTES ? titleName(got.buf.toString('utf8')) : null; }
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > MAX_FILE_BYTES) return null;
    return titleName(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
module.exports = { dirChain, titleName, stateDir, saveTitle, loadTitle };

'use strict';
// Default Pi extension only: closed payload, manifest ownership, no npm or caller-selected paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./install-claude.cjs');
const winfs = require('./win-fs.cjs');
const MANIFEST = '.abito-manifest.json';
const SCHEMA = 'abito-pi-extension/1';
const FILES = Object.freeze(['adapter.cjs', 'ask-tool.cjs', 'config.cjs', 'index.ts', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs']);
const SOURCE = path.resolve(__dirname, '../../desktop-pi');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const refuse = () => core.InstallErrorRefuse('Pi extension ownership or path could not be verified');
const listing = files => JSON.stringify(files);
// HU-052: a folder that is there WITHOUT our manifest is somebody else's (a hand copy, another tool): refused with its own code so the
// human is told what to do. Never adopted, never touched. A folder WITH a manifest that does not verify keeps the generic refusal.
const foreign = () => Object.assign(core.InstallErrorRefuse('Pi extension folder is not a Koda install'), { foreignExtension: true });
function dirCheck(dir, uid) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw refuse();
  if (st.uid !== uid) throw core.unsafeFolder(dir, 'foreign_owner');
  if (st.mode & 0o022) throw core.unsafeFolder(dir, 'writable');
}
function parents(home, uid, create = false, made = []) {
  dirCheck(home, uid);
  let dir = home, missing = false;
  for (const part of ['.pi', 'agent', 'extensions']) {
    dir = path.join(dir, part);
    if (missing && !create) continue;
    try { dirCheck(dir, uid); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (create) { fs.mkdirSync(dir, {mode:0o700}); made.push(dir); dirCheck(dir, uid); }
      else missing = true;
    }
  }
  return dir;
}
function bytes(file, uid, source = false, max = 1024 * 1024) {
  const lst = fs.lstatSync(file);
  if (lst.isSymbolicLink() || !lst.isFile()) throw refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.uid !== uid && !(source && st.uid === 0)) || (st.mode & 0o022) || st.size > max) throw refuse();
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = fs.readSync(fd, buf, off, buf.length - off, off); if (!n) throw refuse(); off += n; }
    return buf;
  } finally { fs.closeSync(fd); }
}
function owned(target, uid) {
  try { dirCheck(target, uid); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!fs.readdirSync(target).includes(MANIFEST)) throw foreign();
  if (listing(fs.readdirSync(target).sort()) !== listing([...FILES, MANIFEST].sort())) throw refuse();
  const raw = bytes(path.join(target, MANIFEST), uid, false, 16384);
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw refuse(); }
  // Closed encoding also rejects duplicate JSON keys and non-UTF8 byte sequences.
  if (![JSON.stringify(manifest), JSON.stringify(manifest) + '\n'].includes(raw.toString('utf8')) || !Buffer.from(raw.toString('utf8')).equals(raw)) throw refuse();
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,schema' || manifest.schema !== SCHEMA || !manifest.files || listing(Object.keys(manifest.files).sort()) !== listing(FILES)) throw refuse();
  for (const name of FILES) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[name]) || hash(bytes(path.join(target, name), uid)) !== manifest.files[name]) throw refuse();
  }
  return { files:manifest.files, signature:hash(Buffer.concat([raw, Buffer.from(listing(manifest.files))])) };
}
function payload(uid) {
  if (fs.realpathSync(SOURCE) !== SOURCE) throw refuse();
  const data = {}, files = {};
  for (const name of FILES) {
    data[name] = bytes(path.join(SOURCE, name === 'index.ts' ? 'pi-extension.ts' : name), uid, true);
    files[name] = hash(data[name]);
  }
  data[MANIFEST] = Buffer.from(JSON.stringify({schema:SCHEMA,files}) + '\n');
  return {data, files};
}
function backupRoot(home, uid, create = false, made = []) {
  const root = path.join(home, '.pi', 'agent', 'abito-backups');
  try { dirCheck(root, uid); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!create) return root;
    fs.mkdirSync(root, {mode:0o700}); made.push(root); dirCheck(root, uid);
  }
  if (fs.lstatSync(root).mode & 0o077) throw refuse();
  return root;
}
function pruneBackups(root, keep, uid) {
  // Unknown or modified entries are not ours to remove. Never descend recursively.
  for (const name of fs.readdirSync(root)) {
    if (!/^abito-island\.abito-backup-[0-9TZ]+(?:-[1-9])?$/.test(name)) continue;
    const dir = path.join(root, name);
    if (dir === keep) continue;
    try { if (owned(dir, uid)) cleanStage(dir); } catch { /* preserve foreign/modified backup */ }
  }
}
function planPi({home, uid, remove, execPath, binPath}) {
  if (winfs.active()) return require('./install-pi-win.cjs').planPi({home, remove, execPath, binPath});
  const parent = parents(home, uid);
  const target = path.join(parent, 'abito-island');
  const root = backupRoot(home, uid);
  const current = owned(target, uid), next = payload(uid);
  const before = current ? JSON.stringify(current.files, null, 2) : '';
  const after = remove ? '' : JSON.stringify(next.files, null, 2);
  const changed = remove ? !!current : before !== after;
  return { settingsPath:target, home, uid, remove, execPath, binPath, timeoutSec:null,
    backupRoot:root, backupTarget:path.join(root, 'abito-island'),
    lockTarget:path.join(home, '.abito-pi-extension'), exists:!!current,
    sig:current ? {sha256:current.signature,size:Buffer.byteLength(before)} : null,
    before, after, changed, data:next.data, files:next.files,
    actions:[{event:'extension',action:!changed ? 'unchanged' : remove ? 'remove' : current ? 'replace' : 'add'}] };
}
function same(plan) {
  parents(plan.home, plan.uid);
  const now = owned(plan.settingsPath, plan.uid);
  return (now?.signature || '') === (plan.sig?.sha256 || '');
}
function write(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// Only this closed staging payload may be cleaned; never recurse through arbitrary entries.
function cleanStage(dir) {
  if (!dir) return;
  try {
    for (const name of [...FILES, MANIFEST]) {
      const file = path.join(dir, name);
      try { const st = fs.lstatSync(file); if (st.isFile() && !st.isSymbolicLink()) fs.unlinkSync(file); } catch { /* own missing file */ }
    }
    fs.rmdirSync(dir);
  } catch { /* leave evidence, never recursively remove unknown data */ }
}
// HU-047 L2: a refusal leaves no empty folder behind. Only directories THIS run created, deepest first, and only when empty.
function removeMade(made, rmdir) {
  for (const dir of [...made].reverse()) { try { rmdir(dir); } catch { /* not empty or not ours any more: leave it */ } }
}
async function applyPi(plan, {backupPath, out, err}) {
  if (winfs.active()) return require('./install-pi-win.cjs').applyPi(plan, {backupPath, out, err});
  let stage = null, saved = false, published = false, done = false;
  const made = [];
  try {
    if (!same(plan)) { err('changed since the preview'); return 70; }
    const parent = parents(plan.home, plan.uid, true, made);
    const root = backupRoot(plan.home, plan.uid, true, made);
    if (root !== plan.backupRoot || fs.statSync(root).dev !== fs.statSync(parent).dev) throw refuse();
    if (!plan.remove) {
      stage = fs.mkdtempSync(path.join(root, '.abito-island-stage-'));
      fs.chmodSync(stage, 0o700);
      for (const [name, data] of Object.entries(plan.data)) write(path.join(stage, name), data);
      if (listing(owned(stage, plan.uid)?.files) !== listing(plan.files)) throw refuse();
    }
    if (!same(plan)) { err('changed since the preview'); return 70; }
    if (plan.exists) {
      // Reserve the backup name without overwriting any existing file or directory.
      fs.mkdirSync(backupPath, {mode:0o700});
      try { fs.renameSync(plan.settingsPath, backupPath); saved = true; }
      catch (e) { fs.rmdirSync(backupPath); throw e; }
    }
    if (!plan.remove) {
      // Directory rename never replaces a populated foreign extension directory.
      fs.renameSync(stage, plan.settingsPath); stage = null; published = true;
      if (listing(owned(plan.settingsPath, plan.uid)?.files) !== listing(plan.files)) throw refuse();
    }
    if (saved) pruneBackups(root, backupPath, plan.uid);
    out('Done. Pi extension updated.\n');
    done = true;
    return 0;
  } catch {
    const verificationFailed = published;
    try {
      if (published) {
        // Preserve unverified bytes outside Pi discovery rather than deleting user changes.
        const quarantine = fs.mkdtempSync(path.join(plan.backupRoot, '.abito-island-quarantine-'));
        fs.renameSync(plan.settingsPath, quarantine);
        published = false;
      }
      if (saved) { fs.renameSync(backupPath, plan.settingsPath); saved = false; }
    } catch { err('could not restore'); return 70; }
    err(verificationFailed ? 'verification failed; previous state restored' : 'could not apply Pi extension');
    return 70;
  } finally { cleanStage(stage); if (!done) removeMade(made, d => fs.rmdirSync(d)); }
}
module.exports = { removeMade, FILES, MANIFEST, SCHEMA, planPi, applyPi};

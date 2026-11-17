'use strict';
// HU-047: Windows flavour of the default Pi extension install. Same closed payload and manifest ownership as
// install-pi.cjs; every check and write goes through the native ACL helper (win-fs.cjs). Cross-volume publication
// is refused, never copied. Nothing here runs on Linux/macOS.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const winfs = require('./win-fs.cjs');
const core = require('./install-claude.cjs');

const MANIFEST = '.abito-manifest.json';
const SCHEMA = 'abito-pi-extension/1';
// K2-04 (S2, S4): same rename as the POSIX twin — koda-island, with a Koda 0.1 `abito-island` folder retired into the existing
// backup flow. A folder there that is not a verified Koda install is never touched.
const TARGET = 'koda-island';
const LEGACY_TARGET = 'abito-island';
const BACKUP_RE = /^(?:koda|abito)-island\.abito-backup-[0-9TZ]+(?:-[1-9])?$/;
const FILES = Object.freeze(['adapter.cjs', 'ask-tool.cjs', 'config.cjs', 'index.ts', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs']);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const refuse = () => core.InstallErrorRefuse('Pi extension ownership or path could not be verified');
const listing = files => JSON.stringify(files);
// HU-052: a folder that is there WITHOUT our manifest is somebody else's (a hand copy, another tool): refused with its own code so the
// human is told what to do. Never adopted, never touched. A folder WITH a manifest that does not verify keeps the generic refusal.
const foreign = () => Object.assign(core.InstallErrorRefuse('Pi extension folder is not a Koda install'), { foreignExtension: true });
const sourceRel = name => `desktop-pi/${name === 'index.ts' ? 'pi-extension.ts' : name}`;
const drive = p => p.slice(0, 2).toLowerCase();
const rand = () => crypto.randomBytes(6).toString('hex');

function dirFact(w, dir) {
  const f = w.checkPath(dir);
  if (!f.exists) return null;
  if (f.reparse || f.kind !== 'dir') throw refuse();
  if (!f.private) throw Object.assign(core.unsafeFolder(dir, 'acl'), { reason: 'not_private' });
  return f;
}
function parents(w, home, create = false, made = []) {
  const h = w.checkPath(path.join(home, '.pi'));
  if (!h.parent_ok) throw Object.assign(core.unsafeFolder(home, 'acl'), { reason: 'not_private' });
  let dir = home, missing = false;
  for (const part of ['.pi', 'agent', 'extensions']) {
    dir = path.join(dir, part);
    if (missing && !create) continue;
    if (dirFact(w, dir) === null) { if (create) { if (w.makeDir(dir).created) made.push(dir); } else missing = true; }
  }
  return dir;
}
function owned(w, target) {
  if (dirFact(w, target) === null) return null;
  if (!fs.readdirSync(target).includes(MANIFEST)) throw foreign();
  if (listing(fs.readdirSync(target).sort()) !== listing([...FILES, MANIFEST].sort())) throw refuse();
  const rawFile = w.readPrivate(path.join(target, MANIFEST));
  if (!rawFile || rawFile.size > 16384) throw refuse();
  const raw = rawFile.buf;
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw refuse(); }
  if (![JSON.stringify(manifest), JSON.stringify(manifest) + '\n'].includes(raw.toString('utf8'))) throw refuse();
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,schema' || manifest.schema !== SCHEMA || !manifest.files || listing(Object.keys(manifest.files).sort()) !== listing(FILES)) throw refuse();
  for (const name of FILES) {
    const got = w.readPrivate(path.join(target, name));
    if (!got || !/^[a-f0-9]{64}$/.test(manifest.files[name]) || got.sha256 !== manifest.files[name]) throw refuse();
  }
  return { files: manifest.files, signature: hash(Buffer.concat([raw, Buffer.from(listing(manifest.files))])) };
}
function payload() {
  const data = {}, files = {};
  for (const name of FILES) {
    data[name] = winfs.readVerified(sourceRel(name));
    files[name] = hash(data[name]);
  }
  data[MANIFEST] = Buffer.from(JSON.stringify({ schema: SCHEMA, files }) + '\n');
  return { data, files };
}
function backupRoot(w, home, create = false, made = []) {
  const root = path.join(home, '.pi', 'agent', 'abito-backups');
  if (dirFact(w, root) === null) {
    if (!create) return root;
    if (w.makeDir(root).created) made.push(root);
  }
  return root;
}
function cleanStage(w, dir) {
  if (!dir) return;
  try {
    for (const name of [...FILES, MANIFEST]) { try { if (w.checkPath(path.join(dir, name)).exists) w.remove(path.join(dir, name)); } catch { /* own missing file */ } }
    w.remove(dir);
  } catch { /* leave evidence, never recurse */ }
}
function pruneBackups(w, root, keep, alsoKeep = null) {
  // `alsoKeep` is the 0.1 folder this run just retired: it is the only copy of it, so the prune never takes it.
  for (const name of fs.readdirSync(root)) {
    if (!BACKUP_RE.test(name)) continue;
    const dir = path.join(root, name);
    if (dir === keep || dir === alsoKeep) continue;
    try { if (owned(w, dir)) cleanStage(w, dir); } catch { /* preserve foreign/modified backup */ }
  }
}
function ownedIfOurs(w, dir) {
  try { return owned(w, dir); } catch { return null; }
}
function planPi({ home, remove, execPath, binPath }) {
  const w = winfs.active();
  const parent = parents(w, home);
  const target = path.join(parent, TARGET);
  const legacyPath = path.join(parent, LEGACY_TARGET);
  const root = backupRoot(w, home);
  const current = owned(w, target), next = payload();
  const legacy = ownedIfOurs(w, legacyPath);
  const before = current ? JSON.stringify(current.files, null, 2) : '';
  const after = remove ? '' : JSON.stringify(next.files, null, 2);
  const changed = remove ? !!(current || legacy) : before !== after || !!legacy;
  return { settingsPath: target, home, uid: 'win', remove, execPath, binPath, timeoutSec: null,
    backupRoot: root, backupTarget: path.join(root, TARGET),
    legacyPath, legacyExists: !!legacy, legacySig: legacy ? legacy.signature : null, legacyBackupTarget: path.join(root, LEGACY_TARGET),
    lockTarget: path.join(home, '.abito-pi-extension'), exists: !!current,
    sig: current ? { sha256: current.signature, size: Buffer.byteLength(before) } : null,
    before, after, changed, data: next.data, files: next.files,
    actions: [{ event: 'extension', action: !changed ? 'unchanged' : remove ? 'remove' : current ? 'replace' : 'add' }] };
}
function same(w, plan) {
  parents(w, plan.home);
  const now = owned(w, plan.settingsPath);
  if ((now?.signature || '') !== (plan.sig?.sha256 || '')) return false;
  return (ownedIfOurs(w, plan.legacyPath)?.signature || '') === (plan.legacySig || '');
}
async function applyPi(plan, { backupPath, out, err, now = () => new Date() }) {
  const w = winfs.active();
  let stage = null, saved = false, published = false, done = false, retired = null;
  const made = [];
  const freeDir = base => core.freeBackupName(base, now(), p => { try { return w.checkPath(p).exists; } catch { return true; } });
  try {
    if (!same(w, plan)) { err('changed since the preview'); return 70; }
    const parent = parents(w, plan.home, true, made);
    const root = backupRoot(w, plan.home, true, made);
    // Never copy across volumes: a cross-volume publication is refused outright.
    if (root !== plan.backupRoot || drive(root) !== drive(parent) || drive(backupPath || root) !== drive(parent)) throw refuse();
    if (!plan.remove) {
      stage = path.join(root, `.abito-island-stage-${rand()}`);
      w.makeDir(stage);
      for (const [name, data] of Object.entries(plan.data)) w.writePrivate(path.join(stage, name), data, null);
      if (listing(owned(w, stage)?.files) !== listing(plan.files)) throw refuse();
    }
    if (!same(w, plan)) { err('changed since the preview'); return 70; }
    if (plan.exists) { w.move(plan.settingsPath, backupPath); saved = true; }
    if (plan.legacyExists) {
      // The 0.1 folder goes into the same backup flow (a dated folder in ~/.pi/agent/abito-backups), never deleted.
      const to = freeDir(plan.legacyBackupTarget);
      if (!to) throw refuse();
      w.move(plan.legacyPath, to); retired = { from: plan.legacyPath, to };
    }
    if (!plan.remove) {
      w.move(stage, plan.settingsPath); stage = null; published = true;
      if (listing(owned(w, plan.settingsPath)?.files) !== listing(plan.files)) throw refuse();
    }
    if (saved) pruneBackups(w, root, backupPath, retired ? retired.to : null);
    out('Done. Pi extension updated.\n');
    done = true;
    return 0;
  } catch {
    const verificationFailed = published;
    try {
      if (published) { w.move(plan.settingsPath, path.join(plan.backupRoot, `.abito-island-quarantine-${rand()}`)); published = false; }
      if (saved) { w.move(backupPath, plan.settingsPath); saved = false; }
      if (retired) { w.move(retired.to, retired.from); retired = null; }
    } catch { err('could not restore'); return 70; }
    err(verificationFailed ? 'verification failed; previous state restored' : 'could not apply Pi extension');
    return 70;
  } finally { cleanStage(w, stage); if (!done) require('./install-pi.cjs').removeMade(made, d => w.remove(d)); }
}
module.exports = { planPi, applyPi, FILES, MANIFEST, SCHEMA, TARGET, LEGACY_TARGET, ownedIfOurs };

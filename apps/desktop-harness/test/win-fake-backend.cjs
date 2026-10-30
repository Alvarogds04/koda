'use strict';
// Shared fake of the HU-047 native helper backend over a POSIX temp dir (same contract: private parent, no symlinks, expectation hashes).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const winfs = require('../src/win-fs.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fakeBackend(log = []) {
  const err = r => new winfs.WinFsError(r);
  const parentOk = p => { try { const st = fs.lstatSync(path.dirname(p)); return st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o022) === 0; } catch { return false; } };
  const facts = p => {
    let st = null; try { st = fs.lstatSync(p); } catch { /* absent */ }
    return { schema: 'abito-fs/1', ok: true, path: p, parent_ok: parentOk(p), exists: !!st, kind: !st ? 'none' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      reparse: !!st && st.isSymbolicLink(), private: !!st && !st.isSymbolicLink() && (st.mode & 0o077) === 0, nlink: st ? st.nlink : 0, size: st ? st.size : 0, mtime_ms: st ? Math.floor(st.mtimeMs) : 0, elevated: false };
  };
  const b = {
    checkPath: p => { log.push(['check', p]); return facts(p); },
    readPrivate(p, { readFile = fs.readFileSync } = {}) {
      const f = facts(p);
      if (!f.parent_ok) throw err('not_private');
      if (!f.exists) return null;
      if (f.reparse) throw err('reparse');
      if (f.kind !== 'file' || !f.private || f.nlink !== 1) throw err('not_private');
      if (f.size > winfs.MAX_FILE) throw err('too_large'); // the real helper caps one read/write at 1 MiB
      const buf = readFile(p);
      return { buf, sha256: sha(buf), size: buf.length, mtimeMs: f.mtime_ms };
    },
    writePrivate(p, data, expect) {
      log.push(['write', p]);
      const f = facts(p);
      if (!f.parent_ok) throw err('not_private');
      if (Buffer.byteLength(data) > winfs.MAX_FILE) throw err('too_large');
      if (expect === null || expect === undefined) { if (f.exists) throw err('exists'); }
      else { if (!f.exists) throw err('missing'); if (f.reparse || !f.private) throw err('not_private'); if (sha(fs.readFileSync(p)) !== expect) throw err('mismatch'); }
      const tmp = path.join(path.dirname(p), `.t${process.pid}${Math.random()}`);
      fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, p);
      return { sha256: sha(Buffer.from(data)) };
    },
    makeDir(p) { if (!parentOk(p)) throw err('not_private'); if (fs.existsSync(p)) return { created: false }; fs.mkdirSync(p, { mode: 0o700 }); return { created: true }; },
    move(a, c) { if (fs.existsSync(c)) throw err('exists'); fs.renameSync(a, c); return { ok: true }; },
    remove(p) { const st = fs.lstatSync(p); if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); return { ok: true }; },
  };
  return b;
}
module.exports = { fakeBackend };

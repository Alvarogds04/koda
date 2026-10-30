'use strict';
/* Self-cleaning temp dirs for the node checks (P3; same idea as the N7 UDS leaves).
   - `make(prefix)` creates `<prefix><pid>-<6 random>` (0700) in the base dir;
   - every dir made by THIS process is removed when it exits (normal exit, uncaught error);
   - dirs of DEAD runs (a killed process cannot clean up) are swept on the next `make`;
   - only dirs of the exact own shape are ever removed: a real directory, ours, 0700, a
     `<prefix><numeric pid>-<6 chars>` name, and a pid that is not alive. Never a symlink,
     a file, another prefix or a dir owned by a live process. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mine = new Set();
let hooked = false;

function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
}
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => { for (const d of mine) removeTree(d); });
  // a terminating signal skips 'exit' unless we turn it into one
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(128));
}

const SHAPE = (prefix) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]{6}$`);

function ours(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return false; }
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700;
}
const alive = (pid) => fs.existsSync(`/proc/${pid}`);

/** Remove dirs of dead runs that match `<prefix><pid>-<6>` exactly. */
function sweep(prefix, base) {
  const re = SHAPE(prefix);
  let entries;
  try { entries = fs.readdirSync(base); } catch { return; }
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    const dir = path.join(base, name);
    if (ours(dir)) removeTree(dir);
  }
}

function make(prefix, opts) {
  const base = (opts && opts.base) || os.tmpdir();
  hook();
  sweep(prefix, base);
  const rand = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
  for (let i = 0; i < 20; i += 1) {
    const dir = path.join(base, `${prefix}${process.pid}-${rand()}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      const real = fs.realpathSync(dir);
      mine.add(real);
      return real;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not create a unique temp dir');
}

module.exports = { make, sweep };

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

// Windows (K2-01b): no process.getuid and no mode bits. make() writes this marker inside each dir it creates there, and
// only marked real dirs directly in the per-user temp dir (private by its profile ACL) are provably ours. Anything else
// (unmarked, a link/junction, another base) is NOT swept: fail closed.
const MARKER = '.abito-tmpdirs';
const perUserTemp = () => { try { return fs.realpathSync.native(os.tmpdir()); } catch { return null; } };
function ours(dir, platform = process.platform) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return false; }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  if (platform === 'win32') {
    const temp = perUserTemp();
    let real, mark;
    try { real = fs.realpathSync.native(dir); mark = fs.lstatSync(path.join(dir, MARKER)); } catch { return false; }
    return temp !== null && path.dirname(real).toLowerCase() === temp.toLowerCase() && mark.isFile() && !mark.isSymbolicLink();
  }
  return st.uid === process.getuid() && (st.mode & 0o777) === 0o700;
}
// Liveness without /proc (macOS has none; K2-01b): signal 0 checks existence only and sends nothing. EPERM = a live
// process we may not signal; ESRCH (or anything else) = gone. 0, negative and values beyond a pid_t would address a
// process GROUP in kill(2) — like the missing /proc/<pid> they are not alive.
const MAX_PID = 2 ** 31 - 1;
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Remove dirs of dead runs that match `<prefix><pid>-<6>` exactly. */
function sweep(prefix, base, opts) {
  const platform = (opts && opts.platform) || process.platform;
  const re = SHAPE(prefix);
  let entries;
  try { entries = fs.readdirSync(base); } catch { return; }
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    const dir = path.join(base, name);
    if (ours(dir, platform)) removeTree(dir);
  }
}

function make(prefix, opts) {
  const base = (opts && opts.base) || os.tmpdir();
  const platform = (opts && opts.platform) || process.platform;
  hook();
  sweep(prefix, base, { platform });
  const rand = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
  for (let i = 0; i < 20; i += 1) {
    const dir = path.join(base, `${prefix}${process.pid}-${rand()}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      if (platform === 'win32') fs.writeFileSync(path.join(dir, MARKER), '', { flag: 'wx' });
      const real = fs.realpathSync(dir);
      mine.add(real);
      return real;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not create a unique temp dir');
}

module.exports = { make, sweep, MARKER };

'use strict';
// HU-047: Windows trust boundary for the hook and Pi installers.
// Node cannot read or set an ACL, so every trust-sensitive fact and every write of an installer-managed file goes
// through the installed sibling `abito-private-session.exe` (never PATH/cwd), whose sha256 must match the install
// manifest before it is executed. The helper verifies owner/DACL/reparse points; this module only speaks its closed
// `abito-fs/1` protocol. Nothing here is loaded on Linux/macOS unless a test injects it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCHEMA = 'abito-fs/1';
const MANIFEST_SCHEMA = 'abito-install/1';
const MANIFEST_FILE = 'abito-install.json';
const HELPER_NAME = 'abito-private-session.exe';
const MAX_FILE = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const REASONS = new Set(['unsafe_path', 'not_private', 'reparse', 'exists', 'missing', 'mismatch', 'too_large', 'busy', 'io']);

class WinFsError extends Error {
  constructor(reason, detail) { super(detail ? `${reason}: ${detail}` : reason); this.reason = reason; }
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// Same lexical rule as winpolicy::fs_path_ok in Rust: X:\a\b, no UNC/device/stream/dot components/reserved names.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
function pathOk(p) {
  if (typeof p !== 'string' || p.length > 520 || !/^[A-Za-z]:\\/.test(p) || p.length < 4) return false;
  return p.slice(3).split('\\').every(c => c !== '' && c !== '.' && c !== '..' && !/[ .]$/.test(c) && !/[\x00-\x1f<>:"|?*/~]/.test(c) && !RESERVED.test(c.split('.')[0]));
}
const need = p => { if (!pathOk(p)) throw new WinFsError('unsafe_path'); return p; };

const FACT_KEYS = ['schema', 'ok', 'path', 'parent_ok', 'exists', 'kind', 'reparse', 'private', 'nlink', 'size', 'mtime_ms', 'elevated'].sort().join(',');
function parseLine(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  if (text.length > 4096 || !/^[^\n]*\n?$/.test(text)) throw new WinFsError('helper_failed', 'helper output is not a single line');
  try { return JSON.parse(text); } catch { throw new WinFsError('helper_failed', 'helper output is not JSON'); }
}
function closed(value) {
  if (!value || typeof value !== 'object' || value.schema !== SCHEMA) throw new WinFsError('helper_failed', 'helper schema mismatch');
  return value;
}

function createWinFs({ helper, exec = execFileSync, verify = () => {} }) {
  function run(args, input) {
    // M2: re-hash the helper immediately before EVERY spawn. Node cannot deny writes to the file, so the window between
    // this check and CreateProcess is the documented residual (same-user race), not a cached verdict.
    verify();
    let raw;
    try {
      raw = exec(helper, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...(input === undefined ? {} : { input }) });
    } catch (e) {
      // Exit 1 with a closed refusal line carries a fixed reason; anything else is an opaque helper failure.
      try {
        const v = closed(parseLine(e && e.stdout));
        if (v.ok === false && REASONS.has(v.reason)) throw new WinFsError(v.reason);
      } catch (inner) { if (inner instanceof WinFsError && inner.reason !== 'helper_failed') throw inner; }
      throw new WinFsError('helper_failed', 'the native helper failed');
    }
    return closed(parseLine(raw));
  }
  const booleans = ['ok', 'parent_ok', 'exists', 'reparse', 'private', 'elevated'];
  function checkPath(p) {
    need(p);
    const v = run(['--check-path', p]);
    const intOk = k => Number.isSafeInteger(v[k]) && v[k] >= 0;
    if (Object.keys(v).sort().join(',') !== FACT_KEYS || v.path !== p || v.ok !== true || !booleans.every(k => typeof v[k] === 'boolean')
      || !['file', 'dir', 'other', 'none'].includes(v.kind) || !intOk('nlink') || !intOk('size') || !intOk('mtime_ms')) throw new WinFsError('helper_failed', 'helper facts malformed');
    return v;
  }
  // Returns {buf, sha256, size, mtimeMs} for a private single-link regular file, null when absent under a private parent.
  function readPrivate(p, { readFile = fs.readFileSync } = {}) {
    const f = checkPath(p);
    if (!f.parent_ok) throw new WinFsError('not_private', 'the parent directory is not private to this user');
    if (!f.exists) return null;
    if (f.reparse) throw new WinFsError('reparse');
    if (f.kind !== 'file' || !f.private || f.nlink !== 1) throw new WinFsError('not_private');
    if (f.size > MAX_FILE) throw new WinFsError('too_large');
    const buf = readFile(p);
    if (buf.length > MAX_FILE) throw new WinFsError('too_large');
    return { buf, sha256: sha256(buf), size: buf.length, mtimeMs: f.mtime_ms };
  }
  const expectArg = e => {
    if (e === null || e === undefined) return 'none';
    if (typeof e === 'string' && HEX64.test(e)) return e;
    throw new WinFsError('bad_expect');
  };
  function writePrivate(p, data, expect) {
    need(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > MAX_FILE) throw new WinFsError('too_large');
    const v = run(['--write-private', p, '--expect', expectArg(expect)], buf);
    if (v.ok !== true || v.sha256 !== sha256(buf) || v.size !== buf.length) throw new WinFsError('helper_failed', 'helper write result mismatch');
    return { sha256: v.sha256 };
  }
  const simple = flag => (...ps) => { ps.forEach(need); const v = run([flag, ...ps]); if (v.ok !== true) throw new WinFsError('helper_failed'); return v; };
  return {
    checkPath, readPrivate, writePrivate,
    makeDir: p => { const v = simple('--make-dir')(p); return { created: v.created === true }; },
    move: simple('--move'), remove: simple('--delete'),
  };
}

// ---- install manifest (receipt) ----
function manifestFiles(deps) {
  const readFile = deps.readFile || fs.readFileSync;
  const root = deps.root;
  if (typeof root !== 'string' || !pathOk(root + '\\x')) throw new WinFsError('helper_untrusted', 'install root invalid');
  let manifest;
  try { manifest = JSON.parse(readFile(path.win32.join(root, MANIFEST_FILE)).toString('utf8')); } catch { throw new WinFsError('helper_untrusted', 'install manifest unreadable'); }
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || Object.keys(manifest).sort().join(',') !== 'files,schema' || !manifest.files || typeof manifest.files !== 'object') throw new WinFsError('helper_untrusted', 'install manifest malformed');
  for (const h of Object.values(manifest.files)) if (typeof h !== 'string' || !HEX64.test(h)) throw new WinFsError('helper_untrusted', 'install manifest malformed');
  return { files: manifest.files, readFile, root };
}
// Single resolver for the native helper: the installed sibling next to the manifest, hash-checked right now.
// `dev` (tests only; installed builds never pass it) additionally allows explicit development candidates.
function resolveHelper(deps = {}) {
  try { return trustedHelper(deps); } catch { /* fall through to the explicit dev path */ }
  if (deps.dev !== true) return undefined;
  const readFile = deps.readFile || fs.readFileSync;
  for (const candidate of deps.devCandidates || []) {
    try { if (readFile(candidate).length > 0) return candidate; } catch { /* next */ }
  }
  return undefined;
}
function trustedHelper(deps = {}) {
  const { files, readFile, root } = manifestFiles({ root: defaultRoot(), ...deps });
  const file = path.win32.join(root, HELPER_NAME);
  let bytes;
  try { bytes = readFile(file); } catch { throw new WinFsError('helper_untrusted', 'helper unreadable'); }
  if (files[HELPER_NAME] !== sha256(bytes)) throw new WinFsError('helper_untrusted', 'helper does not match the install manifest');
  return file;
}
// A script path (relative to the install root, forward slashes) the installer registers must be the manifest-listed bytes.
function verifyScript(rel, deps = {}) {
  let parsed;
  try { parsed = manifestFiles({ root: defaultRoot(), ...deps }); } catch (e) { throw new WinFsError('script_untrusted', e.message); }
  const want = Object.prototype.hasOwnProperty.call(parsed.files, rel) ? parsed.files[rel] : null;
  if (!want || rel.includes('..')) throw new WinFsError('script_untrusted', 'script is not part of the install manifest');
  let bytes;
  try { bytes = parsed.readFile(path.win32.join(parsed.root, ...rel.split('/'))); } catch { throw new WinFsError('script_untrusted', 'script unreadable'); }
  if (sha256(bytes) !== want) throw new WinFsError('script_untrusted', 'script does not match the install manifest');
}
// Reads a bundled file and returns its bytes ONLY if they hash to the manifest entry (single read: no check/use gap).
function readVerified(rel, deps = {}) {
  let parsed;
  try { parsed = manifestFiles({ root: defaultRoot(), ...deps }); } catch (e) { throw new WinFsError('script_untrusted', e.message); }
  const want = Object.prototype.hasOwnProperty.call(parsed.files, rel) ? parsed.files[rel] : null;
  if (!want || rel.includes('..')) throw new WinFsError('script_untrusted', 'file is not part of the install manifest');
  let bytes;
  try { bytes = parsed.readFile(path.win32.join(parsed.root, ...rel.split('/'))); } catch { throw new WinFsError('script_untrusted', 'file unreadable'); }
  if (sha256(bytes) !== want) throw new WinFsError('script_untrusted', 'file does not match the install manifest');
  return bytes;
}
// Registered absolute script path -> manifest-relative name; refuses anything outside the install root.
function relativeToRoot(abs, deps = {}) {
  const root = deps.root || defaultRoot();
  const rel = path.win32.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.win32.isAbsolute(rel)) throw new WinFsError('script_untrusted', 'script is outside the install root');
  return rel.split('\\').join('/');
}
function verifyBundled(abs, deps = {}) { readVerified(relativeToRoot(abs, deps), deps); }
// L6: Windows command lines use double quotes. Refuse characters cmd would expand or that end the quoted string.
function quoteWindowsCommandPath(p) {
  if (typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p) || /["%^&|<>\x00-\x1f]/.test(p)) throw new WinFsError('unsafe_path', 'unsafe character in a command path');
  return `"${p}"`;
}
function defaultRoot() { return path.resolve(__dirname, '..', '..'); }

// ---- active backend: real on win32, injectable in tests ----
let forced = null, cached = null;
function active() {
  if (forced) return forced;
  if (process.platform !== 'win32') return null;
  if (!cached) { const helper = trustedHelper(); cached = createWinFs({ helper, verify: () => { if (trustedHelper() !== helper) throw new WinFsError('helper_untrusted'); } }); }
  return cached;
}
function useForTests(backend) { forced = backend; }
const uidOf = () => (active() ? 'win' : process.getuid());

module.exports = { resolveHelper, quoteWindowsCommandPath, readVerified, verifyBundled, relativeToRoot, WinFsError, createWinFs, trustedHelper, verifyScript, pathOk, active, useForTests, uidOf, sha256, MANIFEST_FILE, MANIFEST_SCHEMA, HELPER_NAME, MAX_FILE };

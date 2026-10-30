'use strict';
// Windows transport for hook clients (T2/S3/S6). On win32 the island's notice
// receiver is a local named pipe served by abito-island.exe; hook clients NEVER
// open that pipe directly. They spawn the native stdio relay
// `abito-notice-relay.exe` with the endpoint metadata path as its only
// argument; the relay re-verifies everything (metadata shape, owner-only DACL,
// live pid, connected server pid+SID) BEFORE forwarding any byte and then
// bridges stdin/stdout. This module wraps that child process as the
// socket-like surface IslandClient expects (connect/data/error/close, write,
// destroy, destroyed, writableLength, setTimeout) so the Unix code path stays
// byte-for-byte identical. Fail closed: when no relay is found at a FIXED
// location the adapter emits error+close and the caller sees exactly the
// existing island-unavailable result — there is NO direct-connection fallback,
// never PATH, and never an env-chosen executable path. Own copy of
// desktop-harness/src/windows-transport.cjs (no cross-app require).
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const RELAY_NAME = 'abito-notice-relay.exe';
// The canonical install root of the island (NSIS InstallDir), derived ONLY from
// LOCALAPPDATA. This fallback exists because the Pi extension may live in a
// global/external npm directory where no sibling relay exists.
const INSTALL_DIR = ['Programs', 'abito-island'];
// Windows drive-absolute path: one ASCII letter, a colon, a slash (the same
// rule the island's winpolicy uses). Control characters are refused outright.
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const noControl = value => ![...value].some(ch => {
  const code = ch.codePointAt(0);
  return code < 0x20 || code === 0x7f;
});
function windowsAbsolute(value) {
  return typeof value === 'string' && value.length >= 3 && DRIVE_RE.test(value) && noControl(value);
}
// Fixed candidate locations, in order. Never PATH, never CWD, never env knobs.
function relayCandidates(env = process.env) {
  const candidates = [
    // Installed layout: this file lives in the desktop-pi package root.
    path.resolve(__dirname, '..', RELAY_NAME),
  ];
  if (windowsAbsolute(env.LOCALAPPDATA)) {
    candidates.push(path.win32.join(env.LOCALAPPDATA, ...INSTALL_DIR, RELAY_NAME));
  }
  // Development/CI layout: the sibling desktop-tauri crate's debug build.
  candidates.push(path.resolve(__dirname, '..', 'desktop-tauri', 'target', 'debug', RELAY_NAME));
  return candidates;
}
// The first candidate that exists as a regular file (never a symlink/dir), or
// undefined: fail closed.
function findRelay(deps = {}) {
  const stat = deps.stat ?? fs.lstatSync;
  for (const candidate of relayCandidates(deps.env)) {
    try {
      const st = stat(candidate);
      if (st.isFile() && !st.isSymbolicLink()) return candidate;
    } catch { /* next candidate */ }
  }
  return undefined;
}

// Socket-like adapter over the relay child process. `deps.spawn` and
// `deps.findRelay`/`deps.stat`/`deps.env` are explicit test seams; production
// uses child_process.spawn and the fixed candidate list above.
function createWindowsConnection(metaPath, deps = {}) {
  const spawn = deps.spawn ?? require('node:child_process').spawn;
  const adapter = new EventEmitter();
  let destroyed = false, closed = false, child = null;
  let idleTimer, idleMs = 0, idleCb;
  const idle = () => {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (!destroyed && idleMs > 0 && typeof idleCb === 'function') idleTimer = setTimeout(idleCb, idleMs);
  };
  Object.defineProperty(adapter, 'destroyed', { get: () => destroyed });
  Object.defineProperty(adapter, 'writableLength', {
    get: () => child && child.stdin && !child.stdin.destroyed ? child.stdin.writableLength : 0,
  });
  adapter.write = (bytes, callback) => {
    if (destroyed || !child || child.stdin.destroyed) return false;
    try { return child.stdin.write(bytes, callback); } catch { return false; }
  };
  adapter.setTimeout = (ms, callback) => {
    idleMs = ms;
    idleCb = typeof callback === 'function' ? callback : undefined;
    idle();
    return adapter;
  };
  adapter.destroy = () => {
    destroyed = true;
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
      try { child.stdin?.destroy(); } catch { /* already gone */ }
    }
  };
  const emitClose = () => { if (!closed) { closed = true; adapter.emit('close'); } };
  const fail = error => {
    if (destroyed || closed) return;
    adapter.emit('error', error);
  };

  const relay = (deps.findRelay ?? findRelay)(deps);
  if (!relay) {
    // Exactly the island-unavailable shape: an error, then close. Never a
    // direct connection to the pipe.
    setImmediate(() => { fail(new Error('abito-notice-relay.exe not found at a fixed installed location')); emitClose(); });
    return adapter;
  }
  try {
    child = spawn(relay, [metaPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    setImmediate(() => { fail(error); emitClose(); });
    return adapter;
  }
  // stdin can EPIPE when the relay dies before reading our frames; that is an
  // adapter error, never an uncaught exception.
  child.stdin?.on('error', error => { fail(error); adapter.destroy(); });
  child.stderr?.resume(); // the relay's one-line diagnostics are never parsed
  child.on('error', error => { fail(error); emitClose(); });
  child.on('spawn', () => { if (!destroyed && !closed) adapter.emit('connect'); });
  // A nonzero exit means the relay refused (metadata, auth, timeouts): surface
  // it as an error before the close so the caller sees the failure, not silence.
  child.on('exit', code => { if (code !== 0 && !destroyed) fail(new Error(`relay exited with code ${code}`)); });
  child.stdout?.on('data', chunk => { idle(); if (!destroyed && !closed) adapter.emit('data', chunk); });
  child.stdout?.on('close', () => { emitClose(); });
  return adapter;
}

module.exports = { createWindowsConnection, relayCandidates, findRelay, RELAY_NAME };

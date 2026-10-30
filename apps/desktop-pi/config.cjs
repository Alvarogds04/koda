'use strict';
// Mirrors apps/desktop-harness/src/config.cjs (own copy; no cross-app require): Pi and the harness hooks resolve
// the island's stable endpoint handoff with the same closed checks, so a plain Pi session behaves like Claude Code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Windows (T2/S3): the island publishes the notice endpoint metadata at the
// canonical `%LOCALAPPDATA%\Abito\notices\endpoint.json`. The hook clients
// never read it as authority — the native relay re-verifies it — so config
// only resolves the path (no /proc, no uid, no directory-chain walk).
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const MAX_WINDOWS_PATH = 4096;
const noControl = value => ![...value].some(ch => {
  const code = ch.codePointAt(0);
  return code < 0x20 || code === 0x7f;
});
function windowsAbsolute(value) {
  return typeof value === 'string' && value.length >= 3 && DRIVE_RE.test(value) &&
    value.length <= MAX_WINDOWS_PATH && noControl(value);
}
// The metadata path the relay accepts as its argument: an absolute, normalized
// Windows path NAMED endpoint.json (the only name the island publishes).
function windowsEndpointShape(endpoint) {
  return windowsAbsolute(endpoint) && !endpoint.endsWith('\\') && !endpoint.endsWith('/') &&
    path.win32.normalize(endpoint) === endpoint &&
    path.win32.basename(endpoint) === 'endpoint.json';
}
function resolveConfigWindows(env, options = {}) {
  const stat = options.stat ?? fs.lstatSync;
  const explicit = env.ABITO_DESKTOP_SOCKET;
  if (explicit !== undefined) {
    // The override only chooses WHICH metadata file the relay verifies — it
    // never bypasses the relay itself.
    if (!windowsEndpointShape(explicit)) throw new Error('Unexpected endpoint');
    return { runtime: path.win32.dirname(explicit), endpoint: explicit, source: 'env' };
  }
  if (!windowsAbsolute(env.LOCALAPPDATA)) return { runtime: undefined, endpoint: undefined, source: undefined };
  const runtime = path.win32.join(env.LOCALAPPDATA, 'Abito', 'notices');
  const endpoint = path.win32.join(runtime, 'endpoint.json');
  try {
    const st = stat(endpoint);
    if (!st.isFile() || st.isSymbolicLink()) return { runtime, endpoint: undefined, source: undefined };
  } catch { return { runtime, endpoint: undefined, source: undefined }; }
  return { runtime, endpoint, source: 'handoff' };
}


function normalized(value) {
  return typeof value === 'string' && value !== '/' && path.isAbsolute(value) &&
    path.normalize(value) === value && !value.endsWith('/') && !value.includes('\0');
}
// sockaddr_un.sun_path: 108 bytes on Linux, 104 on macOS, both including the NUL.
const SUN_PATH_MAX = process.platform === 'darwin' ? 103 : 107;
// Per-user runtime base. Linux: $XDG_RUNTIME_DIR, else /run/user/<uid>. macOS has neither: the
// per-user temp dir (same directory as confstr(_CS_DARWIN_USER_TEMP_DIR) in the Tauri transport),
// canonicalized because /var is a symlink and the directory-chain check refuses symlinks.
function runtimeBase(env, owner) {
  if (process.platform === 'darwin') {
    try { return fs.realpathSync(os.tmpdir()); } catch { throw new Error('No runtime base'); }
  }
  return normalized(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : `/run/user/${owner}`;
}
function endpointShape(endpoint, runtime) {
  return normalized(endpoint) && Buffer.byteLength(endpoint) <= SUN_PATH_MAX &&
    path.dirname(path.dirname(endpoint)) === runtime && path.basename(endpoint) === 's' &&
    /^p-[a-zA-Z0-9]{6}$/.test(path.basename(path.dirname(endpoint)));
}
const MAX_HANDOFF = 4096;
// macOS has no /proc: the same pid facts come from `/bin/ps` (absolute path, fixed argv, no shell, bounded timeout).
// The block below is a verbatim copy of apps/desktop-daemon/src/procinfo.cjs (PS, PS_ARGS, parsePsLine, runPs): this
// extension ships alone into ~/.pi/agent/extensions and cannot require the daemon file. test/proc-darwin.test.cjs pins
// the two copies identical. Any failure (ps missing, pid gone, unparseable output) is `undefined`, which readHandoff
// treats as "pid not confirmed" and therefore refuses the endpoint (fail closed).
const PS = "/bin/ps";
const PS_ARGS = ["-ww", "-o", "lstart=", "-o", "ppid=", "-o", "state=", "-o", "uid=", "-o", "command="];
/** `lstart` in the C locale is always exactly 24 characters: `Mon Jan  2 15:04:05 2006`. */
const LSTART_LENGTH = 24;

/** Pure parser of one `ps` line. Returns {start, ppid, state, uid, command} or undefined. */
function parsePsLine(line) {
	if (typeof line !== "string") return undefined;
	const text = line.replace(/\r?\n$/, "");
	if (text.length <= LSTART_LENGTH) return undefined;
	const millis = Date.parse(text.slice(0, LSTART_LENGTH).trim());
	if (!Number.isFinite(millis)) return undefined;
	const match = /^\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(text.slice(LSTART_LENGTH));
	if (!match) return undefined;
	const ppid = Number(match[1]);
	const uid = Number(match[3]);
	if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid)) return undefined;
	// Whole seconds since the epoch, decimal digits only: the same shape as the Linux clock ticks.
	return { start: String(Math.floor(millis / 1000)), ppid, state: match[2][0], uid, command: match[4] };
}

function runPs(pid, exec = execFileSync) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		const out = exec(PS, [...PS_ARGS, "-p", String(pid)], {
			encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024,
		});
		const lines = String(out).split("\n").filter((entry) => entry.trim() !== "");
		return lines.length === 1 ? parsePsLine(lines[0]) : undefined;
	} catch {
		return undefined;
	}
}
const darwinProc = {
  exists: pid => runPs(pid) !== undefined,
  state: pid => runPs(pid)?.state,
  start: pid => runPs(pid)?.start,
};
function readProcState(pid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/${pid}/stat`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(512);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const stat = buffer.toString('utf8', 0, n);
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    return /^\s+([A-Za-z])(?:\s|$)/.exec(stat.slice(close + 1))?.[1];
  } catch { return undefined; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
// Field 22 of /proc/<pid>/stat (process start time in clock ticks) as a decimal string. `comm` may contain spaces and
// parentheses, so the fields are parsed after the LAST ')'. `undefined` when unreadable. Mirrors the island's `proc_start`.
function readProcStart(pid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/${pid}/stat`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(1024);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const stat = buffer.toString('utf8', 0, n);
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const ticks = stat.slice(close + 2).split(' ')[22 - 3];
    return typeof ticks === 'string' && /^[0-9]+$/.test(ticks) ? ticks : undefined;
  } catch { return undefined; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
// Stable handoff `<runtime>/endpoint.json`: a pointer, not authority. Any failure => undefined (silent).
function readHandoff(runtime, owner, procExists, procState, procStart) {
  let fd;
  try {
    fd = fs.openSync(`${runtime}/endpoint.json`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || st.size > MAX_HANDOFF ||
        (st.mode & 0o7777) !== 0o600 || st.nlink !== 1) return undefined;
    const buffer = Buffer.alloc(MAX_HANDOFF + 1);
    const n = fs.readSync(fd, buffer, 0, MAX_HANDOFF + 1, 0);
    if (n > MAX_HANDOFF) return undefined;
    const text = buffer.toString('utf8', 0, n);
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const canonical = JSON.stringify(value);
    if (text !== canonical && text !== `${canonical}\n`) return undefined;
    // closed key set: v, endpoint, pid and, optionally, procStart (the island's identity of the pid)
    const keys = Object.keys(value).sort().join();
    const hasStart = keys === 'endpoint,pid,procStart,v';
    if (keys !== 'endpoint,pid,v' && !hasStart) return undefined;
    if (value.v !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647) return undefined;
    if (typeof value.endpoint !== 'string' || !endpointShape(value.endpoint, runtime)) return undefined;
    // Load lazily to avoid config.cjs <-> security.cjs initialization cycles.
    require('./security.cjs').verifyEndpoint(value.endpoint, runtime);
    if (!procExists(value.pid)) return undefined;
    const state = procState(value.pid);
    if (typeof state !== 'string' || !/^[A-Za-z]$/.test(state) || state === 'Z' || state === 'X') return undefined;
    // Present = the pid is an IDENTITY: a recycled pid has another start time. Absent keeps the existence-only
    // behaviour. A claimed value that is malformed, or a start time we cannot read, fails closed.
    if (hasStart) {
      const claimed = value.procStart;
      if (typeof claimed !== 'string' || !/^[0-9]+$/.test(claimed)) return undefined;
      if (procStart(value.pid) !== claimed) return undefined;
    }
    return value.endpoint;
  } catch { return undefined; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
// Resolving configuration never creates a directory or connects a socket.
function resolveConfig(env, owner, options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return resolveConfigWindows(env, options);
  if (!Number.isInteger(owner) || owner < 0) throw new Error('Linux uid required');
  // Default: the Tauri island's own leaf, exactly where `src/transport.rs default_runtime` binds
  // (`$XDG_RUNTIME_DIR/abito-island`). The Electron production (`abito-desktop`) and Preview
  // (`abito-desktop-preview`) roots are never a default: they need an explicit ABITO_SOCKET_DIR.
  const xdg = runtimeBase(env, owner);
  const runtime = env.ABITO_SOCKET_DIR ?? `${xdg}/abito-island`;
  if (!normalized(runtime)) throw new Error('Invalid ABITO_SOCKET_DIR');
  const explicit = env.ABITO_DESKTOP_SOCKET;
  if (explicit !== undefined) {
    if (!endpointShape(explicit, runtime)) throw new Error('Unexpected endpoint');
    return { runtime, endpoint: explicit, source: 'env' };
  }
  const mac = (options.platform ?? process.platform) === 'darwin';
  const procExists = options.procExists ?? (mac ? darwinProc.exists : pid => fs.existsSync(`/proc/${pid}`));
  const procState = options.procState ?? (mac ? darwinProc.state : readProcState);
  const procStart = options.procStart ?? (mac ? darwinProc.start : readProcStart);
  const endpoint = readHandoff(runtime, owner, procExists, procState, procStart);
  return { runtime, endpoint, source: endpoint === undefined ? undefined : 'handoff' };
}
// The current endpoint published by the running island, or undefined. Called on EVERY connection attempt: an island
// restart binds a new `<runtime>/p-XXXXXX/s`, so a resolved-at-start path would go stale. Never throws.
function resolveEndpoint(env, owner, options = {}) {
  try { return resolveConfig(env, owner, options).endpoint; } catch { return undefined; }
}
function resolveQuestionConfig(env) {
  const { timeoutValid, DEFAULT_TIMEOUT_MS } = require('./questions.cjs');
  if (env.ABITO_QUESTIONS !== undefined && !['0', '1', '2', '3'].includes(env.ABITO_QUESTIONS)) {
    throw new Error('ABITO_QUESTIONS must be 0, 1, 2 or 3');
  }
  const raw = env.ABITO_QUESTION_TIMEOUT_MS;
  const questionTimeoutMs = raw === undefined ? DEFAULT_TIMEOUT_MS : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!timeoutValid(questionTimeoutMs)) throw new Error('Invalid ABITO_QUESTION_TIMEOUT_MS');
  // Default 3 (human, 30-oct: «Arreglarlo en Abito: preguntas activadas por defecto»): the extension is installed by the
  // same Abito build as the island it talks to, so the island always speaks QP/1 and negotiates `structured` itself.
  // ABITO_QUESTIONS=0 keeps the old notice-only behaviour.
  return { questionLevel: Number(env.ABITO_QUESTIONS ?? '3'), questionTimeoutMs };
}
module.exports = { darwinProc: { ...darwinProc, runPs, parsePsLine, PS, PS_ARGS }, resolveConfig, resolveEndpoint, resolveQuestionConfig, endpointShape, windowsEndpointShape };

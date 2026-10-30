'use strict';
// Claude Code status-line relay for the plan-usage gauge (#467 T10 slice 4).
// Idea adapted from Coucou hook/src/statusline.rs @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Claude hands this command the session JSON on stdin; whatever it prints becomes the status line.
// We keep ONLY the two rate-limit windows (numbers) and hand them to the island through
// `<runtime>/plan-claude.json` (0600, atomic). If the user had a status line of their own it is run
// with the same input and its output is printed untouched. Never blocks Claude: every failure is silent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHANNEL = 'plan-claude.json';
const MAX_OUTPUT = 64 * 1024;
const PREVIOUS_BUDGET_MS = 10000;
const DAY_MS = 86400000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function normalized(v) {
  return typeof v === 'string' && v !== '/' && path.isAbsolute(v) && path.normalize(v) === v && !v.endsWith('/') && !v.includes('\0');
}
// Same default as the harness config: ABITO_SOCKET_DIR, else $XDG_RUNTIME_DIR/abito-island, else /run/user/<uid>/abito-island.
function runtimeDir(env, uid) {
  if (env.ABITO_SOCKET_DIR !== undefined) return normalized(env.ABITO_SOCKET_DIR) ? env.ABITO_SOCKET_DIR : null;
  if (normalized(env.XDG_RUNTIME_DIR)) return `${env.XDG_RUNTIME_DIR}/abito-island`;
  return `/run/user/${uid}/abito-island`;
}
const channelPath = runtime => path.join(runtime, CHANNEL);
// The user's own status line waits in their home (the runtime dir is tmpfs and does not survive a reboot).
const previousPath = home => path.join(home, '.abito', 'statusline-previous.json');

function window(raw, nowMs) {
  if (!isObj(raw)) return undefined;
  const pct = raw.used_percentage, epoch = raw.resets_at;
  if (!isNum(pct) || !isNum(epoch)) return undefined;
  if (pct < 0 || pct > 200) return undefined;
  if (epoch <= 0 || epoch * 1000 > nowMs + 400 * DAY_MS) return undefined; // ms in disguise
  return { used_percentage: pct, resets_at: epoch };
}
// The plan numbers of a status-line input, or null. Nothing else of the input is kept.
function extractPlan(input, nowMs = Date.now()) {
  const rl = isObj(input) ? input.rate_limits : null;
  if (!isObj(rl)) return null;
  const five = window(rl.five_hour, nowMs), seven = window(rl.seven_day, nowMs);
  if (!five && !seven) return null;
  const out = { v: 1, at: nowMs };
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  return out;
}

// tmp (O_EXCL, 0600) + rename: readers never see half a file and a symlink at the target is replaced, not followed.
function writeChannel(runtime, plan) {
  let tmp = null;
  try {
    tmp = path.join(runtime, `.${CHANNEL}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify(plan) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, channelPath(runtime));
    return true;
  } catch {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    return false;
  }
}

function readPrevious(home) {
  try {
    const p = previousPath(home);
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
    const c = isObj(saved) ? saved.command : null;
    return typeof c === 'string' && c.trim() !== '' ? c : null;
  } catch { return null; }
}

// The shell Claude Code itself runs a statusLine command with. Unix: `/bin/sh -c`. Windows: Git Bash when installed, PowerShell
// otherwise (https://code.claude.com/docs/en/statusline, «Windows configuration»), found ONLY at fixed absolute locations, never
// by PATH lookup: CLAUDE_CODE_GIT_BASH_PATH (absolute, an existing file named bash.exe), %ProgramFiles%\\Git\\bin\\bash.exe,
// %ProgramFiles(x86)%\\Git\\bin\\bash.exe, then %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe. Returns null when none is usable.
function previousShell({ platform = process.platform, env = process.env, exists } = {}) {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c'] };
  const w = require('node:path').win32;
  // Windows environment names are case-insensitive; a plain copy of process.env (spread, tests, a parent that rebuilds it) is not.
  const get = name => { const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase()); return k === undefined ? undefined : env[k]; };
  const isFile = exists || (p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const absolute = p => typeof p === 'string' && /^[A-Za-z]:\\/.test(p) && w.normalize(p) === p && !p.includes('\0');
  const candidates = [];
  if (absolute(get('CLAUDE_CODE_GIT_BASH_PATH')) && w.basename(get('CLAUDE_CODE_GIT_BASH_PATH')).toLowerCase() === 'bash.exe') candidates.push(get('CLAUDE_CODE_GIT_BASH_PATH'));
  for (const root of [get('ProgramFiles'), get('ProgramFiles(x86)')]) if (absolute(root)) candidates.push(w.join(root, 'Git', 'bin', 'bash.exe'));
  for (const c of candidates) if (isFile(c)) return { file: c, args: ['-c'] };
  const sysRoot = get('SystemRoot');
  if (!absolute(sysRoot)) return null;
  const ps = w.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return isFile(ps) ? { file: ps, args: ['-NoProfile', '-NonInteractive', '-Command'] } : null;
}

// Runs `command` as Claude Code does (see previousShell) with `input` on stdin. Returns up to 64 KiB of stdout, or null
// when it could not start or ran past `budgetMs` (then it is killed). Synchronous façade over a child process.
function runPrevious(command, input, budgetMs = PREVIOUS_BUDGET_MS, { env } = {}) {
  const { spawnSync } = require('node:child_process');
  const shell = previousShell({ env: env ?? process.env });
  if (!shell) return null;
  const r = spawnSync(shell.file, [...shell.args, command], { input, timeout: budgetMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT * 4, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...(env ? { env } : {}) });
  if (r.error && r.error.code !== 'ENOBUFS') return null;
  if (!r.stdout) return null;
  return r.stdout.subarray(0, MAX_OUTPUT);
}

module.exports = { extractPlan, writeChannel, readPrevious, runPrevious, previousShell, runtimeDir, channelPath, previousPath, CHANNEL };

"use strict";

/**
 * Read-only discovery of LIVE agent sessions (#360, F046/F049): a bounded scan of
 * Linux /proc metadata for RUNNING agent processes (Pi first), so the island can
 * show a ticker of who is working where and from which terminal.
 *
 * Nothing here writes, spawns or executes anything; it only reads the user's own
 * process metadata (cmdline, stat, comm, cwd symlink of same-user processes) and
 * emits a CLOSED projection: a derived anonymous id, a closed agent kind, the cwd
 * BASENAME (never the full path), a closed process state and a terminal origin
 * only when a KNOWN terminal host appears on the parent chain. Command lines,
 * arguments, environment, full paths and any other process detail never leave
 * this module. The scan is bounded (pids and sessions) and platform-gated:
 * non-Linux platforms scan nothing and answer an honest empty result.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "abito-sessions/view/1";

const MAX_PIDS = 4096;
const MAX_SESSIONS = 64;
const MAX_ANCESTORS = 8;

/** Closed agent kinds. The basename of an early argv entry maps to exactly one kind; nothing else matches. */
const KINDS = Object.freeze([
	{ kind: "pi", binary: "pi" },
	{ kind: "claude-code", binary: "claude" },
	{ kind: "codex", binary: "codex" },
	{ kind: "opencode", binary: "opencode" },
	{ kind: "gemini", binary: "gemini" },
]);
const KIND_BY_BINARY = new Map(KINDS.map((k) => [k.binary, k.kind]));

/** Known terminal hosts: the first ancestor whose comm matches yields the origin. */
const TERMINALS = Object.freeze([
	"herdr", "tmux", "screen", "kitty", "alacritty", "gnome-terminal", "konsole", "xterm", "wezterm", "ghostty", "code",
]);

/** Process state char (/proc/<pid>/stat field 3) mapped to a closed list. */
const STATES = Object.freeze({
	R: "running", S: "sleeping", D: "running", Z: "zombie", T: "stopped", t: "stopped", I: "sleeping",
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Any control character (C0/C1, bidi, separators, lone surrogates): never emitted. */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

const basename = (p) => (typeof p === "string" && p ? path.posix.basename(p.replace(/\\/g, "/")) : "");

/**
 * Parses `/proc/<pid>/stat`: fields after the last `)` start at the state char. The
 * comm (between the first `(` and the last `)`) travels too: the parent-chain walk
 * needs it and /proc always carries it there.
 */
function parseStat(text) {
	if (typeof text !== "string") return undefined;
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open === -1 || close === -1 || close < open) return undefined;
	const fields = text.slice(close + 1).trim().split(" ");
	if (fields.length < 20) return undefined;
	return { comm: text.slice(open + 1, close), state: fields[0], ppid: Number(fields[1]), starttime: Number(fields[19]) };
}

function kindOf(cmdlineText) {
	if (typeof cmdlineText !== "string") return undefined;
	const args = cmdlineText.split("\0").filter((a) => a !== "").slice(0, 3);
	for (const arg of args) {
		const kind = KIND_BY_BINARY.get(basename(arg));
		if (kind) return kind;
	}
	return undefined;
}

/**
 * The terminal origin: walk the parent chain looking for a KNOWN terminal host's
 * comm. Closed names only; anything else (unknown hosts, a reaped parent) is null.
 */
function originOf(root, pid) {
	let current = pid;
	for (let hop = 0; hop < MAX_ANCESTORS; hop++) {
		let stat;
		try {
			stat = parseStat(fs.readFileSync(path.join(root, String(current), "stat"), "utf8"));
		} catch {
			return null;
		}
		if (!stat) return null;
		// The ancestor itself may be the terminal host (ppid 1 or not): check its comm
		// BEFORE deciding to stop, or a top-level tmux/herdr would never be found.
		const known = TERMINALS.find((t) => stat.comm === t || stat.comm.startsWith(`${t}:`) || stat.comm.startsWith(`${t}-`));
		if (known) return known;
		if (!Number.isInteger(stat.ppid) || stat.ppid <= 1) return null;
		current = stat.ppid;
	}
	return null;
}

/**
 * One scan: a bounded read of /proc producing the closed session rows. Returns
 * `{ sessions, truncated }`; a missing or unreadable proc dir is an empty result.
 */
const MAX_PID = 4194304; // Linux pid_max ceiling
/** `ABITO_SESSIONS_SCOPE_PID` as a pid, or null. Digits only: anything else never narrows the scan. */
function sessionScope(env) {
	const raw = env?.ABITO_SESSIONS_SCOPE_PID;
	if (typeof raw !== "string" || !/^[1-9][0-9]{0,6}$/.test(raw)) return null;
	const pid = Number(raw);
	return pid <= MAX_PID ? pid : null;
}

/** True when `scope` is `pid` or one of its ancestors. A cycle or a vanished parent ends the walk: not in scope. */
function inScope(root, pid, scope) {
	let current = pid;
	for (let hop = 0; hop < MAX_ANCESTORS; hop++) {
		if (current === scope) return true;
		let stat;
		try {
			stat = parseStat(fs.readFileSync(path.join(root, String(current), "stat"), "utf8"));
		} catch {
			return false;
		}
		if (!stat || !Number.isInteger(stat.ppid) || stat.ppid <= 0 || stat.ppid === current) return false;
		current = stat.ppid;
	}
	return false;
}

function scanSessions({ procDir = "/proc", platform = process.platform, scopePid = null } = {}) {
	// Narrowing only (a validation run must see its own sessions, never the human's); a bad value is ignored.
	const scope = Number.isInteger(scopePid) && scopePid >= 1 && scopePid <= MAX_PID ? scopePid : null;
	if (platform !== "linux") return { sessions: [], truncated: false };
	let names;
	try {
		names = fs.readdirSync(procDir);
	} catch {
		return { sessions: [], truncated: false };
	}
	const sessions = [];
	let truncated = false;
	let total = 0; // every session seen, so a truncated result can say how many there really are
	for (const name of names.slice(0, MAX_PIDS)) {
		if (!/^[0-9]+$/.test(name)) continue;
		const dir = path.join(procDir, name);
		let cmdline, stat;
		try {
			cmdline = fs.readFileSync(path.join(dir, "cmdline"), "utf8");
			stat = parseStat(fs.readFileSync(path.join(dir, "stat"), "utf8"));
		} catch {
			continue; // vanished mid-scan or not readable: not a session, never an error
		}
		const kind = kindOf(cmdline);
		if (!kind || !stat) continue;
		if (scope !== null && !inScope(procDir, Number(name), scope)) continue;
		let cwd = null;
		try {
			const target = fs.readlinkSync(path.join(dir, "cwd"));
			const base = basename(target);
			if (base && !FORBIDDEN_TEXT.test(base) && !base.includes("/")) cwd = base.slice(0, 64);
		} catch {
			cwd = null; // e.g. a process we cannot follow: honest "unknown", never a guess
		}
		const starttime = Number.isInteger(stat.starttime) ? stat.starttime : 0;
		const id = `s-${crypto.createHash("sha256").update(`${name} ${starttime}`).digest("hex").slice(0, 8)}`;
		total += 1;
		if (sessions.length >= MAX_SESSIONS) {
			truncated = true; // keep scanning (bounded by MAX_PIDS) only to count, never to emit
			continue;
		}
		sessions.push({
			id,
			kind,
			cwd,
			state: STATES[stat.state] ?? "unknown",
			origin: originOf(procDir, Number(name)),
		});
	}
	return truncated ? { sessions, truncated, total } : { sessions, truncated };
}

// ----- strict rebuild for the wire (protocol.cjs delegates here) -------------

const ID_SHAPE = /^s-[0-9a-f]{8}$/;

/** Validates one closed row: unknown fields dropped, anything off-vocabulary rejected. */
function buildSession(raw) {
	if (!isObject(raw)) throw new Error("sessions frame invalid");
	const id = raw.id;
	const kind = raw.kind;
	const state = raw.state;
	if (typeof id !== "string" || !ID_SHAPE.test(id)) throw new Error("sessions frame invalid");
	const kinds = new Set(KINDS.map((k) => k.kind));
	if (!kinds.has(kind)) throw new Error("sessions frame invalid");
	if (typeof state !== "string" || !Object.values(STATES).concat(["unknown"]).includes(state)) throw new Error("sessions frame invalid");
	const cleanText = (v, max) => {
		if (v === null) return null;
		if (typeof v !== "string" || v === "" || v.length > max || v.includes("/") || FORBIDDEN_TEXT.test(v)) throw new Error("sessions frame invalid");
		return v;
	};
	const out = { id, kind, cwd: cleanText(raw.cwd, 64), state, origin: cleanText(raw.origin, 32) };
	if (raw.tools !== undefined) out.tools = buildTools(raw.tools);
	return out;
}

/**
 * Strict rebuild of the session rows for the `sessions` frame. THROWS on invalid
 * data (the server answers `failed`); callers cap before calling, but an over-cap
 * array is rejected here too, so nothing is ever silently truncated.
 */
function buildSessions(rows) {
	if (!Array.isArray(rows) || rows.length > MAX_SESSIONS) throw new Error("sessions frame invalid");
	return rows.map(buildSession);
}

// Names only: never tool arguments, command text, paths or results.
const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;
function buildTools(raw) {
	if (!isObject(raw) || !Number.isSafeInteger(raw.total) || raw.total < 0 || raw.total > 4096 || !Array.isArray(raw.steps) || raw.steps.length !== Math.min(raw.total, 20)) throw new Error('tools invalid');
	if (raw.epoch !== undefined && (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0)) throw new Error('tools invalid');
	return { ...(raw.epoch === undefined ? {} : { epoch: raw.epoch }), total: raw.total, steps: raw.steps.map((s, i) => {
		if (!isObject(s) || s.index !== raw.total - raw.steps.length + i + 1 || typeof s.name !== 'string' || !TOOL_NAME.test(s.name) || !['running', 'done', 'error'].includes(s.state)) throw new Error('tools invalid');
		return { index: s.index, name: s.name, state: s.state };
	}) };
}
class ToolHistory {
	constructor() { this.total = 0; this.steps = []; this.ids = new Set(); }
	accept(event) {
		const id = event?.toolCallId;
		if (typeof id !== 'string' || !id || id.length > 256) return;
		if (event.type === 'tool_execution_start') {
			if (this.ids.has(id) || typeof event.toolName !== 'string' || !TOOL_NAME.test(event.toolName)) return;
			if (this.ids.size >= 4096) { this.exhausted = true; return; }
			this.ids.add(id);
			this.steps.push({ id, index: ++this.total, name: event.toolName, state: 'running' });
			this.steps = this.steps.slice(-20);
		} else if (event.type === 'tool_execution_end') {
			const step = this.steps.find(s => s.id === id);
			if (step && step.state === 'running') step.state = event.isError === true ? 'error' : 'done';
		}
	}
	view() { return this.exhausted ? null : buildTools({ total: this.total, steps: this.steps }); }
}
// Same anonymous process identity as discovery; unreadable/dead processes cannot
// claim a stream. No PID or /proc content is projected to the frontend.
function sessionIdForPid(pid) {
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	try {
		const stat = parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
		if (!Number.isInteger(stat?.starttime)) return null;
		return `s-${crypto.createHash('sha256').update(`${pid} ${stat.starttime}`).digest('hex').slice(0, 8)}`;
	} catch { return null; }
}
module.exports = { SCHEMA, scanSessions, sessionScope, buildSessions, MAX_SESSIONS, ToolHistory, buildTools, sessionIdForPid };

"use strict";

/**
 * Agent hooks catalogue (#361, F047, F048): preview / install / remove of the Abito
 * island hooks for the agent clients NOT covered by the harness installer
 * (agents.cjs drives claude-code and codex through apps/desktop-harness; this module
 * never touches its code or its clients' files). The four native clients are
 * "self-owned artifact" adapters: Koda writes whole files it owns, marker-tagged
 * `koda-island-hooks/1` on the first line, and removes only files that carry it.
 * K2-04 (S2, S4): a Koda 0.1 artifact (`abito-island-hooks/1`, old `abito-island*`
 * names, `.abito/agent-hooks/`) is recognised as OUR OWN: install retires it into the
 * existing backup flow and writes the new one, so each client keeps exactly one card
 * per notice; remove takes it out too. A file without either marker stays foreign.
 *
 * Verified formats (official sources read 2026-10-16; see tests/PROTOCOL.md):
 *  - gemini-cli: a Gemini CLI extension directory `~/.gemini/extensions/koda-island/`
 *    with `gemini-extension.json` and `hooks/hooks.json` holding the event map DIRECTLY
 *    (verified against gemini-cli packages/core/src/hooks/hookRegistry.ts). Events used:
 *    SessionStart, SessionEnd, Notification (advisory only — it can never block).
 *  - copilot-cli: user-level hooks file `~/.copilot/hooks/koda-island.json`,
 *    `{version:1,hooks:{sessionStart:[...],sessionEnd:[...]}}`, entries
 *    `{type:"command",exec,args,timeoutSec}` (docs.github.com hooks reference).
 *  - opencode: whole-file plugin `~/.config/opencode/plugins/koda-island.js`
 *    (opencode.ai/docs/plugins); `event` hook for session.created / session.idle /
 *    permission.asked.
 *  - cursor (#467): the USER's `~/.cursor/hooks.json` (`{version:1,hooks:{<event>:[{command}]}}`,
 *    camelCase events; format adapted from Coucou src-tauri/src/agents.rs @434d6a2b,
 *    Copyright (c) 2026 Louis Raillé, MIT). Unlike the other clients this file is NOT
 *    self-owned: install MERGES three marker-tagged entries (sessionStart, sessionEnd, stop)
 *    and keeps everything else byte-semantically; remove drops only entries carrying the
 *    marker (the file is deleted only when nothing but our `version` stub would be left).
 *    Unparseable JSON or an unexpected `hooks` shape is `foreign_file`, never rewritten.
 *  - amp: single-file plugin `~/.config/amp/plugins/koda-island.js`
 *    (ampcode.com/docs/customize/plugins); default export, `amp.on("session.start")`
 *    and `amp.on("agent.end")` — Amp has NO session.end event.
 *
 * Notify-only v1 (coordinator-approved): the generated artifacts tell the island
 * about session start/end and permission notices through the QP/1 `settled` notice
 * flow. They never block the CLI: the notify script always exits 0 and every
 * generated callback swallows failures. UNVERIFIED pieces (best-effort by
 * construction) are listed in tests/PROTOCOL.md.
 *
 * SAFETY CONTRACT (high risk: writes outside the project, into other clients' dirs):
 *  - Nothing runs at daemon start or during a scan. Scan = read-only.
 *  - install/remove run ONLY on an explicit call carrying the exact plan_hash the
 *    caller was shown; the plan is RECOMPUTED from scratch and compared, and any
 *    mismatch means `plan_changed` with NOTHING written.
 *  - Every overwrite or delete is preceded by a backup of the old bytes (the backup
 *    keeps the original mode; our artifacts are 0600).
 *  - A file at a target without our marker is `foreign_file`: refused, never replaced.
 *  - A target that is a symlink (or otherwise not a regular file) is `unsafe_target`.
 *  - The gemini extension directory is scanned and removed only when it contains
 *    nothing but the artifacts Abito wrote (`unexpected_content` otherwise).
 *  - Every path is asserted to stay inside the injected home, and EVERY filesystem
 *    operation goes through the injected fs seam (tests record every path touched;
 *    node:fs is used directly only where the seam has no equivalent — none today).
 *  - Writes are atomic (temp file + rename, 0600, verified byte-exact) and the whole
 *    operation is all-or-nothing: any failure restores the backups before reporting.
 */

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const { assertSecurePath } = require("./isolation.cjs");
const { validateHome } = require("./mcp-import.cjs");

const SCHEMA = "abito-agent-hooks/1";
const MARKER = "koda-island-hooks/1";
// K2-04 (S2, S4): the Koda 0.1 marker. Still OUR OWN: recognised by isOurs, so a 0.1 artifact is retired/removed instead of
// being left behind to make the client show a second card. The protocol schema id above does not change.
const LEGACY_MARKER = "abito-island-hooks/1";
const ARTIFACT_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_CHARS = 300;
const CLIENT_IDS = Object.freeze(["gemini-cli", "copilot-cli", "opencode", "amp", "cursor"]);
const HASH = /^[0-9a-f]{64}$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
/** Canonical JSON: keys sorted recursively, no whitespace (deterministic plan binding). */
const canonical = (value) => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
};

// ----- closed catalogue ----------------------------------------------------------------

const CLIENTS = Object.freeze([
	Object.freeze({ id: "gemini-cli", name: "Gemini CLI", script: true }),
	Object.freeze({ id: "copilot-cli", name: "Copilot CLI", script: true }),
	Object.freeze({ id: "opencode", name: "OpenCode", script: false }),
	Object.freeze({ id: "amp", name: "Amp", script: false }),
	Object.freeze({ id: "cursor", name: "Cursor", script: true }),
]);
const SCRIPT_REL = ".koda/agent-hooks/island-notify.mjs";
/** The clients whose generated hooks reference the shared notify script. */
const SCRIPT_DEPENDENTS = Object.freeze(["gemini-cli", "copilot-cli", "cursor"]);
/** K2-04: the Koda 0.1 names, recognised and retired in place. Same clients, same shapes. */
const LEGACY_SCRIPT_REL = ".abito/agent-hooks/island-notify.mjs";
const LEGACY_RELS = Object.freeze({
	"gemini-cli": Object.freeze([".gemini/extensions/abito-island/gemini-extension.json", ".gemini/extensions/abito-island/hooks/hooks.json"]),
	"copilot-cli": Object.freeze([".copilot/hooks/abito-island.json"]),
	opencode: Object.freeze([".config/opencode/plugins/abito-island.js"]),
	amp: Object.freeze([".config/amp/plugins/abito-island.js"]),
	// cursor is the SAME file (~/.cursor/hooks.json): its 0.1 entries carry the legacy marker and are recognised there.
	cursor: Object.freeze([]),
});
/** Managed directory chains removed (rmdir, only when empty) after deletions. Both names: the 0.1 ones go with the new ones. */
const MANAGED_DIRS = Object.freeze([
	".gemini/extensions/koda-island/hooks",
	".gemini/extensions/koda-island",
	".gemini/extensions/abito-island/hooks",
	".gemini/extensions/abito-island",
]);
/** Contents each managed gemini directory may hold (anything else: unexpected_content). */
const GEMINI_ALLOWED = Object.freeze([
	{ dir: ".gemini/extensions/koda-island", allowed: ["gemini-extension.json", "hooks"] },
	{ dir: ".gemini/extensions/koda-island/hooks", allowed: ["hooks.json"] },
	{ dir: ".gemini/extensions/abito-island", allowed: ["gemini-extension.json", "hooks"] },
	{ dir: ".gemini/extensions/abito-island/hooks", allowed: ["hooks.json"] },
]);

// ----- generated artifact templates (English artifacts; pure functions of inputs) ------

/** POSIX single-quote a word: an embedded `'` closes, escapes and reopens the quote (R17). */
const singleQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const NOTIFY_CORE = `
const RUNTIME_MAX = 4096;
const sha = (v) => createHash("sha256").update(v).digest("hex");
const clean = (raw) => String(raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 128);
const sessionToken = (raw) => {
  const c = clean(raw);
  return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(c) ? c : "h-" + sha(String(raw ?? "")).slice(0, 32);
};

// Endpoint discovery mirrors the island handoff contract: <runtime>/endpoint.json is a
// pointer, never authority. Any failure => no notification (silent, always exit 0).
function discoverEndpoint(env, uid) {
  let runtime;
  if (typeof env.KODA_SOCKET_DIR === "string" && env.KODA_SOCKET_DIR.startsWith("/")) runtime = env.KODA_SOCKET_DIR;
  else if (typeof env.XDG_RUNTIME_DIR === "string" && env.XDG_RUNTIME_DIR.startsWith("/")) runtime = env.XDG_RUNTIME_DIR + "/koda";
  else runtime = "/run/user/" + uid + "/koda";
  let fd;
  try {
    fd = fs.openSync(runtime + "/endpoint.json", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.size > RUNTIME_MAX || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1) return undefined;
    const buf = Buffer.alloc(RUNTIME_MAX + 1);
    const n = fs.readSync(fd, buf, 0, RUNTIME_MAX + 1, 0);
    if (n > RUNTIME_MAX) return undefined;
    const value = JSON.parse(buf.toString("utf8", 0, n));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const keys = Object.keys(value).sort().join();
    if (keys !== "endpoint,pid,v" && keys !== "endpoint,pid,procStart,v") return undefined;
    if (value.v !== 1 || typeof value.endpoint !== "string") return undefined;
    if (!value.endpoint.startsWith(runtime + "/")) return undefined;
    if (!/^p-[a-zA-Z0-9]{6}\\/s$/.test(value.endpoint.slice(runtime.length + 1))) return undefined;
    return value.endpoint;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function readStdin(maxBytes) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (v) => { if (!done) { done = true; try { process.stdin.destroy(); } catch { /* ignore */ } resolve(v); } };
    const t = setTimeout(() => finish(undefined), 3000);
    process.stdin.on("data", (c) => { size += c.length; if (size > maxBytes) finish(undefined); else chunks.push(c); });
    process.stdin.on("end", () => { clearTimeout(t); finish(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", () => { clearTimeout(t); finish(undefined); });
  });
}

// One QP/1 settled notice: connect, answer the island's ready, send, leave. Never throws.
function notify(endpoint, scope) {
  return new Promise((resolve) => {
    let settled = false; let buf = Buffer.alloc(0);
    const socket = net.createConnection(endpoint);
    const done = () => { if (!settled) { settled = true; clearTimeout(t); try { socket.destroy(); } catch { /* ignore */ } resolve(); } };
    const t = setTimeout(done, 3000);
    socket.on("connect", () => { try { socket.write(JSON.stringify({ v: 1, type: "hello", ...scope, at: Date.now() }) + "\\n"); } catch { done(); } });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let end;
      while ((end = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, end).toString("utf8");
        buf = buf.subarray(end + 1);
        if (line !== '{"v":1,"type":"ready"}') { done(); return; }
        const frame = JSON.stringify({ v: 1, type: "settled", id: randomUUID(), ...scope, at: Date.now() });
        try { socket.write(frame + "\\n", () => setTimeout(done, 250)); } catch { done(); }
        return;
      }
    });
    socket.on("error", done);
    socket.on("close", done);
  });
}
`;

const notifyScript = () => `#!/usr/bin/env node
// ${MARKER} shared island notify script (gemini-cli, copilot-cli, cursor).
// Generated by the Abito island daemon. Manual edits make this file unmanaged: the
// daemon refuses to update or remove a file whose marker line is missing.
// Best effort only: this script always exits 0 and never blocks the CLI.
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
${NOTIFY_CORE}
const CLIENT = typeof process.argv[2] === "string" ? process.argv[2] : "";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const endpoint = discoverEndpoint(process.env, uid);
if (!endpoint || CLIENT === "") process.exit(0);
const payload = await readStdin(1024 * 1024);
let data;
try { data = payload ? JSON.parse(payload) : undefined; } catch { data = undefined; }
if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) data = undefined;
const cwd = typeof data?.cwd === "string" && data.cwd.startsWith("/") ? data.cwd : process.cwd();
let project;
try { project = sha(fs.realpathSync(cwd)); } catch { process.exit(0); }
const rawSession = data?.sessionId ?? data?.session_id ?? process.env.GEMINI_SESSION_ID ?? "";
await notify(endpoint, { project, sessionId: sessionToken(rawSession), at: Date.now() });
process.exit(0);
`;

const opencodePlugin = () => `// ${MARKER} opencode plugin — generated by the Abito island daemon.
// Manual edits make this file unmanaged: the daemon refuses to update or remove a
// file whose marker line is missing. Notifications only: this plugin never blocks
// OpenCode (every callback swallows failures).
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
${NOTIFY_CORE}
export const AbitoIslandPlugin = async ({ directory }) => {
  const push = (event, sessionId) => {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const endpoint = discoverEndpoint(process.env, uid);
      if (!endpoint) return;
      const cwd = typeof directory === "string" && directory.startsWith("/") ? directory : process.cwd();
      let project;
      try { project = sha(fs.realpathSync(cwd)); } catch { return; }
      notify(endpoint, { project, sessionId: sessionToken(sessionId), at: Date.now() }).catch(() => {});
    } catch { /* notifications are best effort */ }
  };
  return {
    event: async ({ event }) => {
      try {
        const type = event?.type;
        const id = event?.properties?.info?.id ?? event?.properties?.sessionID ?? "";
        if (type === "session.created") push("session-start", id);
        else if (type === "session.idle") push("session-end", id);
        else if (type === "permission.asked") push("permission", id);
      } catch { /* notifications are best effort */ }
    },
  };
};
`;

const ampPlugin = () => `// ${MARKER} amp plugin — generated by the Abito island daemon.
// Manual edits make this file unmanaged: the daemon refuses to update or remove a
// file whose marker line is missing. Notifications only: this plugin never blocks
// Amp (every callback swallows failures). Amp has no session.end event; agent.end
// marks the end of a turn.
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
${NOTIFY_CORE}
export default function (amp) {
  const push = (event, sessionId) => {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const endpoint = discoverEndpoint(process.env, uid);
      if (!endpoint) return;
      let project;
      try { project = sha(fs.realpathSync(process.cwd())); } catch { return; }
      notify(endpoint, { project, sessionId: sessionToken(sessionId), at: Date.now() }).catch(() => {});
    } catch { /* notifications are best effort */ }
  };
  try {
    amp.on("session.start", (event) => { try { push("session-start", event?.thread?.id ?? ""); } catch { /* ignore */ } });
    amp.on("agent.end", () => { try { push("session-end", ""); } catch { /* ignore */ } });
  } catch { /* notifications are best effort */ }
}
`;

// ----- cursor: merge into the user's ~/.cursor/hooks.json -------------------------------

const CURSOR_REL = ".cursor/hooks.json";
const CURSOR_EVENTS = Object.freeze(["sessionStart", "sessionEnd", "stop"]);
/** The shell command of each Abito entry; the trailing comment carries the marker. */
const cursorCommands = (nodeExe, scriptPath) =>
	Object.fromEntries(CURSOR_EVENTS.map((event) => [event, `${singleQuote(nodeExe)} ${singleQuote(scriptPath)} cursor ${event} # ${MARKER}`]));
const isOurCursorCommand = (command) =>
	typeof command === "string" && (command.includes(MARKER) || command.includes(LEGACY_MARKER)) && command.includes(" cursor ");
const isOurCursorEntry = (entry) => isObject(entry) && isOurCursorCommand(entry.command);

/** Parses the user's file; `undefined` when it is not a shape we can safely edit. */
function parseCursor(text) {
	if (text === undefined) return {};
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(value)) return undefined;
	if (value.hooks !== undefined && !isObject(value.hooks)) return undefined;
	if (value.hooks && Object.values(value.hooks).some((list) => !Array.isArray(list))) return undefined;
	return value;
}

const cursorHasOurs = (root) => isObject(root.hooks) && Object.values(root.hooks).some((list) => list.some(isOurCursorEntry));

/** `root` without any Abito entry; emptied events (and an emptied `hooks`) go. */
function cursorStrip(root) {
	const out = { ...root };
	if (!isObject(root.hooks)) return out;
	const hooks = {};
	for (const [event, list] of Object.entries(root.hooks)) {
		const kept = list.filter((e) => !isOurCursorEntry(e));
		if (kept.length > 0 || kept.length === list.length) hooks[event] = kept;
	}
	if (Object.keys(hooks).length > 0) out.hooks = hooks;
	else delete out.hooks;
	return out;
}

/** `root` with exactly one Abito entry per event; earlier Abito entries are replaced. */
function cursorAdd(root, commands) {
	const stripped = cursorStrip(root);
	const hooks = { ...(stripped.hooks ?? {}) };
	for (const event of CURSOR_EVENTS) hooks[event] = [...(hooks[event] ?? []), { command: commands[event] }];
	const out = { ...stripped, hooks };
	if (out.version === undefined) out.version = 1;
	return out;
}

const cursorText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Resolves the merged artifact against the user's current text: `install` is the file
 * with our entries (the existing bytes when already exactly there), `remove` the file
 * without them (`null` = delete it, we only had our own stub). `undefined` = foreign.
 */
function cursorResolve(text, commands) {
	const root = parseCursor(text);
	if (root === undefined) return undefined;
	const added = cursorAdd(root, commands);
	const install = text !== undefined && canonical(added) === canonical(root) ? text : cursorText(added);
	const stripped = cursorStrip(root);
	const onlyStub = Object.keys(stripped).length === 1 && stripped.version === 1;
	const remove = cursorHasOurs(root) ? (onlyStub ? null : cursorText(stripped)) : text;
	return { install, remove, hasOurs: cursorHasOurs(root) };
}

/** The exact bytes of every artifact a client owns, given the environment inputs. */
function artifactsFor(clientId, home, nodeExe) {
	const client = CLIENTS.find((c) => c.id === clientId);
	if (!client) return undefined;
	const scriptPath = path.join(home, SCRIPT_REL);
	const out = [];
	if (clientId === "gemini-cli") {
		out.push({
			rel: ".gemini/extensions/koda-island/gemini-extension.json",
			content: `${JSON.stringify({ name: "koda-island", version: "1.0.0", description: `Koda island notifications (hooks) ${MARKER}` }, null, "\t")}\n`,
		});
		out.push({
			rel: ".gemini/extensions/koda-island/hooks/hooks.json",
			content: `${JSON.stringify(
				{
					SessionStart: [{ matcher: "", hooks: [{ name: "koda-island", description: `Koda island notice ${MARKER}`, type: "command", command: `${singleQuote(nodeExe)} ${singleQuote(scriptPath)} gemini session-start`, timeout: 10000 }] }],
					SessionEnd: [{ matcher: "", hooks: [{ name: "koda-island", description: `Koda island notice ${MARKER}`, type: "command", command: `${singleQuote(nodeExe)} ${singleQuote(scriptPath)} gemini session-end`, timeout: 10000 }] }],
					Notification: [{ matcher: "", hooks: [{ name: "koda-island", description: `Koda island notice ${MARKER}`, type: "command", command: `${singleQuote(nodeExe)} ${singleQuote(scriptPath)} gemini notification`, timeout: 10000 }] }],
				},
				null,
				"\t",
			)}\n`,
		});
	} else if (clientId === "copilot-cli") {
		out.push({
			rel: ".copilot/hooks/koda-island.json",
			content: `${JSON.stringify(
				{
					version: 1,
					hooks: {
						sessionStart: [{ type: "command", env: { KODA_ISLAND_HOOKS: MARKER }, exec: nodeExe, args: [scriptPath, "copilot", "session-start"], timeoutSec: 10 }],
						sessionEnd: [{ type: "command", env: { KODA_ISLAND_HOOKS: MARKER }, exec: nodeExe, args: [scriptPath, "copilot", "session-end"], timeoutSec: 10 }],
					},
				},
				null,
				"\t",
			)}\n`,
		});
	} else if (clientId === "opencode") {
		out.push({ rel: ".config/opencode/plugins/koda-island.js", content: opencodePlugin() });
	} else if (clientId === "amp") {
		out.push({ rel: ".config/amp/plugins/koda-island.js", content: ampPlugin() });
	} else if (clientId === "cursor") {
		// merged: `content` is computed from the user's current file (see cursorMerge).
		out.push({ rel: CURSOR_REL, merged: true, commands: cursorCommands(nodeExe, scriptPath), content: "" });
	}
	if (client.script) out.push({ rel: SCRIPT_REL, content: notifyScript(), shared: true });
	return { client, artifacts: out };
}

// ----- guarded filesystem ------------------------------------------------------------------

/**
 * Wraps the fs seam so that every path is asserted to be absolute and to stay inside
 * `home`. All module code uses absolute paths built from home; the seam makes any
 * escape impossible to miss in tests (every touched path is recorded).
 */
function guardedFs(fsSeam, home) {
	// R18: the lexical check is not enough: a symlinked intermediate directory (dotfile
	// managers) would send writes outside home. Resolve the deepest existing ancestor of
	// the PARENT (never the leaf, which callers lstat) and require it inside realpath(home).
	let realHome = home;
	if (typeof fsSeam.realpathSync === "function") {
		try {
			realHome = fsSeam.realpathSync(home);
		} catch {
			realHome = home;
		}
	}
	const inside = (p, root) => p === root || p.startsWith(root + path.sep);
	const assertRealInside = (resolved) => {
		if (typeof fsSeam.realpathSync !== "function" || resolved === home) return;
		let dir = path.dirname(resolved);
		const tail = [];
		for (;;) {
			try {
				const real = path.join(fsSeam.realpathSync(dir), ...tail);
				if (!inside(real, realHome)) throw new Error("path escapes home");
				return;
			} catch (error) {
				if (error && error.message === "path escapes home") throw error;
				if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw new Error("path escapes home");
				const up = path.dirname(dir);
				if (up === dir) throw new Error("path escapes home");
				tail.unshift(path.basename(dir));
				dir = up;
			}
		}
	};
	const assertInside = (p) => {
		if (typeof p !== "string" || !path.isAbsolute(p)) throw new Error("path escapes home");
		const resolved = path.resolve(p);
		if (resolved !== home && !resolved.startsWith(home + path.sep)) throw new Error("path escapes home");
		assertRealInside(resolved);
		return resolved;
	};
	const wrap = (name) => (target, ...rest) => fsSeam[name](assertInside(target), ...rest);
	return {
		lstatSync: wrap("lstatSync"),
		readFileSync: wrap("readFileSync"),
		writeFileSync: wrap("writeFileSync"),
		mkdirSync: wrap("mkdirSync"),
		renameSync: wrap("renameSync"),
		unlinkSync: wrap("unlinkSync"),
		rmdirSync: wrap("rmdirSync"),
		copyFileSync: wrap("copyFileSync"),
		readdirSync: wrap("readdirSync"),
	};
}

const fail = (message) => {
	throw new Error(message);
};

/** Strict target read: regular non-symlink file, bounded, valid UTF-8; absent when missing. */
function readTarget(fsOps, file) {
	let st;
	try {
		st = fsOps.lstatSync(file);
	} catch (error) {
		if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { absent: true };
		return { problem: "unsafe_target" };
	}
	if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return { problem: "unsafe_target" };
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fsOps.readFileSync(file));
		return { text, size: st.size };
	} catch {
		return { problem: "unsafe_target" };
	}
}

/** `true` when the text is one of ours (marker tag on the first line, current or Koda 0.1). */
const isOurs = (text, rel) =>
	typeof text === "string" && (rel.endsWith(".json") ? text.includes(MARKER) || text.includes(LEGACY_MARKER) : text.split("\n", 3).slice(0, 2).some((l) => l.includes(MARKER) || l.includes(LEGACY_MARKER)));

// ----- diff ------------------------------------------------------------------------------

/** Sanitizes one diff line the way the harness does: control chars to '?', cut at 300. */
function diffLine(raw) {
	const clean = String(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
	return clean.length > MAX_DIFF_CHARS ? clean.slice(0, MAX_DIFF_CHARS) : clean;
}

/**
 * Builds the bounded diff for the planned targets. A line that had to be sanitized or
 * cut marks the preview as not fully reviewable; overflow lines are counted in `hidden`.
 */
function buildDiff(targets) {
	const lines = [];
	let hidden = 0;
	let sanitized = false;
	const push = (raw) => {
		if (lines.length >= MAX_DIFF_LINES) {
			hidden++;
			return;
		}
		const line = diffLine(raw);
		if (line !== String(raw) || line.length >= MAX_DIFF_CHARS) sanitized = true;
		lines.push(line);
	};
	for (const target of targets) {
		push(`@@ ${target.rel} (${target.action})`);
		if (target.action === "replace" || target.action === "delete") {
			for (const line of String(target.before ?? "").split("\n")) if (line !== "") push(`- ${line}`);
		}
		if (target.action === "create" || target.action === "replace") {
			for (const line of String(target.after ?? "").split("\n")) if (line !== "") push(`+ ${line}`);
		}
	}
	return { lines, hidden, reviewable: hidden === 0 && !sanitized };
}

// ----- state + plans -----------------------------------------------------------------------

/** Canonical plan JSON: everything the plan binds; timestamps excluded. */
function planHash(clientId, action, targets) {
	return sha256Hex(
		canonical({
			schema: SCHEMA,
			v: ARTIFACT_VERSION,
			client: clientId,
			action,
			targets: targets.map((t) => ({
				path: t.abs,
				exists: t.exists,
				sha256: t.exists ? sha256Hex(t.before ?? "") : "",
				size: t.exists ? t.size : 0,
				result: t.action === "delete" ? "" : sha256Hex(t.after ?? ""),
			})),
		}),
	);
}

const summaries = {
	"gemini-cli": {
		install: "Installs the Koda island extension for Gemini CLI (~/.gemini/extensions/koda-island). A backup is made first. Notifications only: the island never answers for Gemini CLI.",
		remove: "Removes the Koda island extension for Gemini CLI. A backup is made first.",
	},
	"copilot-cli": {
		install: "Installs the Koda island hooks file for Copilot CLI (~/.copilot/hooks/koda-island.json). A backup is made first. Notifications only.",
		remove: "Removes the Koda island hooks file for Copilot CLI. A backup is made first.",
	},
	opencode: {
		install: "Installs the Koda island plugin for OpenCode (~/.config/opencode/plugins/koda-island.js). A backup is made first. Notifications only.",
		remove: "Removes the Koda island plugin for OpenCode. A backup is made first.",
	},
	cursor: {
		install: "Adds the Koda island hooks (sessionStart, sessionEnd, stop) to ~/.cursor/hooks.json, keeping your own hooks. A backup is made first. Notifications only. Restart Cursor to pick them up.",
		remove: "Removes only the Koda island hooks from ~/.cursor/hooks.json. A backup is made first.",
	},
	amp: {
		install: "Installs the Koda island plugin for Amp (~/.config/amp/plugins/koda-island.js). A backup is made first. Notifications only.",
		remove: "Removes the Koda island plugin for Amp. A backup is made first.",
	},
};

/** Plan DTO with the fresh diff and hash for one action's target list. */
const planDto = (clientId, action, targets) => {
	const d = buildDiff(targets);
	return {
		plan_hash: planHash(clientId, action, targets),
		changed: targets.length > 0,
		summary: summaries[clientId][action],
		reviewable: d.reviewable,
		diff: { lines: d.lines, hidden: d.hidden },
	};
};

/** Reads one client's artifacts strictly; returns {reads} or {problem}. */
function readArtifacts(fsOps, home, nodeExe, clientId) {
	const built = artifactsFor(clientId, home, nodeExe);
	const reads = [];
	for (const artifact of built.artifacts) {
		const abs = path.join(home, artifact.rel);
		const read = readTarget(fsOps, abs);
		if (read.problem) return { problem: read.problem };
		if (artifact.merged) {
			const resolved = cursorResolve(read.text, artifact.commands);
			if (resolved === undefined) return { problem: "foreign_file" };
			reads.push({ artifact: { ...artifact, content: resolved.install }, abs, text: read.text, size: read.size ?? 0, absent: read.absent === true, merged: resolved });
			continue;
		}
		reads.push({ artifact, abs, text: read.text, size: read.size ?? 0, absent: read.absent === true });
	}
	return { built, reads };
}

/** The shared script is in use while any OTHER dependent client still owns an artifact. */
function scriptInUseByOthers(fsOps, home, nodeExe, clientId) {
	for (const other of SCRIPT_DEPENDENTS.filter((id) => id !== clientId)) {
		const scan = readArtifacts(fsOps, home, nodeExe, other);
		if (scan.problem) continue; // unreadable others cannot prove the script is free
		if (scan.reads.some((r) => !r.artifact.shared && r.text !== undefined && (r.merged ? r.merged.hasOurs : isOurs(r.text, r.artifact.rel)))) return true;
	}
	return false;
}

// ----- K2-04: the Koda 0.1 artifacts, recognised and retired --------------------------------

/**
 * Strict reads of one client's Koda 0.1 artifacts. Only files carrying OUR marker (current or 0.1) become targets to delete;
 * a file at an old name without it is somebody else's and is left exactly where it is. Like the current artifacts, an unsafe
 * target refuses the whole plan instead of guessing.
 */
function readLegacy(fsOps, home, clientId) {
	const targets = [];
	for (const rel of LEGACY_RELS[clientId] ?? []) {
		const abs = path.join(home, rel);
		const read = readTarget(fsOps, abs);
		if (read.problem) return { problem: read.problem };
		if (read.absent || !isOurs(read.text, rel)) continue;
		targets.push({ rel, abs, exists: true, before: read.text, size: read.size, action: "delete", legacy: true });
	}
	return { targets };
}

/** Cursor's 0.1 entries live in the user's own ~/.cursor/hooks.json: still calling the 0.1 script while one carries the 0.1 marker. */
function cursorLegacyInUse(fsOps, home) {
	const read = readTarget(fsOps, path.join(home, CURSOR_REL));
	if (read.problem || read.absent) return false;
	const root = parseCursor(read.text);
	if (!root || !isObject(root.hooks)) return false;
	return Object.values(root.hooks).some((list) => list.some((e) => isObject(e) && typeof e.command === "string" && e.command.includes(LEGACY_MARKER) && e.command.includes(" cursor ")));
}

/** The shared 0.1 notify script is in use while another dependent client's 0.1 artifact still carries our marker. */
function legacyScriptInUse(fsOps, home, clientId) {
	if (clientId !== "cursor" && cursorLegacyInUse(fsOps, home)) return true;
	for (const other of SCRIPT_DEPENDENTS.filter((id) => id !== clientId && id !== "cursor")) {
		const scan = readLegacy(fsOps, home, other);
		if (scan.problem) continue; // unreadable others cannot prove the 0.1 script is free
		if (scan.targets.length > 0) return true;
	}
	return false;
}

/** The 0.1 script itself, when it is ours and no other client still uses it (an unsafe one is simply left alone). */
function legacyScriptTarget(fsOps, home, clientId, client) {
	if (!client.script || legacyScriptInUse(fsOps, home, clientId)) return [];
	const abs = path.join(home, LEGACY_SCRIPT_REL);
	const read = readTarget(fsOps, abs);
	if (read.problem || read.absent || !isOurs(read.text, LEGACY_SCRIPT_REL)) return [];
	return [{ rel: LEGACY_SCRIPT_REL, abs, exists: true, before: read.text, size: read.size, action: "delete", legacy: true }];
}

/**
 * Every target one action needs: the client's own artifacts plus the 0.1 artifacts it retires. `undefined` when a 0.1
 * artifact cannot be read safely (the caller reports that detail and writes nothing).
 */
function targetsOf(fsOps, home, nodeExe, clientId, action, built, reads) {
	const legacy = readLegacy(fsOps, home, clientId);
	if (legacy.problem) return undefined;
	const retiring = [...legacy.targets, ...legacyScriptTarget(fsOps, home, clientId, built.client)];
	const keepScript = built.client.script && scriptInUseByOthers(fsOps, home, nodeExe, clientId);
	const fresh = action === "install" ? installTargetsOf(reads) : removeTargetsOf(reads, keepScript);
	return [...fresh, ...retiring];
}

/** Install targets from strict reads: everything that differs from the wanted bytes. */
const installTargetsOf = (reads) =>
	reads
		.filter((r) => r.text !== r.artifact.content)
		.map((r) => ({ rel: r.artifact.rel, abs: r.abs, exists: !r.absent, before: r.text, size: r.size, after: r.artifact.content, action: r.absent ? "create" : "replace" }));

/** Remove targets: owned files are deleted; a merged file is rewritten without our entries. */
function removeTargetsOf(reads, keepScript) {
	const out = [];
	for (const r of reads) {
		if (r.text === undefined || (r.artifact.shared && keepScript)) continue;
		if (r.merged) {
			if (!r.merged.hasOurs) continue;
			if (r.merged.remove === null) out.push({ rel: r.artifact.rel, abs: r.abs, exists: true, before: r.text, size: r.size, action: "delete" });
			else out.push({ rel: r.artifact.rel, abs: r.abs, exists: true, before: r.text, size: r.size, after: r.merged.remove, action: "replace" });
			continue;
		}
		out.push({ rel: r.artifact.rel, abs: r.abs, exists: true, before: r.text, size: r.size, action: "delete" });
	}
	return out;
}

/**
 * Scans ONE client (read-only) and returns its entry: state, detail and — when safe —
 * the install and remove plans. Never writes, never creates.
 */
function scanClient(clientId, fsOps, home, platform, nodeExe) {
	const entry = { id: clientId, name: CLIENTS.find((c) => c.id === clientId).name, mechanism: "artifact", state: "error", detail: null, install: null, remove: null };
	if (platform !== "linux" && platform !== "darwin") {
		entry.detail = "unsupported_platform";
		return entry;
	}
	const scan = readArtifacts(fsOps, home, nodeExe, clientId);
	if (scan.problem) {
		entry.detail = scan.problem;
		return entry;
	}
	const { built, reads } = scan;

	// The managed gemini directories must hold nothing but our own artifacts.
	for (const { dir, allowed } of GEMINI_ALLOWED) {
		let names;
		try {
			names = fsOps.readdirSync(path.join(home, dir));
		} catch (error) {
			if (error && error.code === "ENOENT") continue; // simply absent
			entry.detail = "unsafe_target";
			return entry;
		}
		if (names.some((n) => !allowed.includes(n) && !n.includes(".abito-backup-"))) {
			entry.detail = "unexpected_content";
			return entry;
		}
	}

	// Foreign content at any of our targets is refused, never replaced.
	if (reads.some((r) => !r.merged && r.text !== undefined && !isOurs(r.text, r.artifact.rel))) {
		entry.detail = "foreign_file";
		return entry;
	}

	const clientFiles = reads.filter((r) => !r.artifact.shared);
	const script = reads.find((r) => r.artifact.shared);
	const scriptOk = !built.client.script || (script !== undefined && script.text === script.artifact.content);
	// K2-04: a 0.1 artifact still present (and ours) means the client is outdated, never "not connected": the next install
	// replaces it, so exactly one card per notice survives.
	const installTargets = targetsOf(fsOps, home, nodeExe, clientId, "install", built, reads);
	const removeTargets = targetsOf(fsOps, home, nodeExe, clientId, "remove", built, reads);
	if (installTargets === undefined || removeTargets === undefined) {
		entry.detail = "unsafe_target";
		return entry;
	}
	const legacyPending = installTargets.some((t) => t.legacy === true);
	const allExact = clientFiles.every((r) => r.text === r.artifact.content) && scriptOk && !legacyPending;
	const nonePresent = clientFiles.every((r) => (r.merged ? !r.merged.hasOurs : r.text === undefined)) && !legacyPending;
	entry.state = allExact ? "connected" : nonePresent ? "not_connected" : "outdated";
	entry.detail = null;

	entry.install = planDto(clientId, "install", installTargets);
	entry.remove = planDto(clientId, "remove", removeTargets);
	return entry;
}

/** Validates options and returns the guarded context; throws on anything unexpected. */
function context(options) {
	const home = validateHome(options.home);
	const fsSeam = options.fs ?? nodeFs;
	return {
		home,
		fsOps: guardedFs(fsSeam, home),
		platform: options.platform ?? process.platform,
		nodeExe: typeof options.nodeExe === "string" && options.nodeExe !== "" && path.isAbsolute(options.nodeExe) && !/\p{Cc}/u.test(options.nodeExe) ? options.nodeExe : fail("invalid nodeExe"),
		now: typeof options.now === "function" ? options.now : typeof options.now === "number" ? () => options.now : Date.now,
		log: options.log ?? (() => {}),
	};
}

/** Read-only catalogue scan. Never writes, never creates. */
function scanAgentHooks(options = {}) {
	const ctx = context(options);
	return { clients: CLIENT_IDS.map((id) => scanClient(id, ctx.fsOps, ctx.home, ctx.platform, ctx.nodeExe)) };
}

// ----- mutation: one op at a time, hash-bound, backed up, atomic, verified ---------------

const activeOps = new Set();

function withOp(clientId, fn) {
	if (activeOps.has(clientId)) return { ok: false, code: "busy" };
	activeOps.add(clientId);
	try {
		return fn();
	} finally {
		activeOps.delete(clientId);
	}
}

/**
 * Writes the backup of `target` (bytes already read and verified UTF-8) as a NEW file:
 * `wx` + 0600, so it never overwrites an existing backup (EEXIST => next -1..-9 suffix)
 * and never inherits a wider mode from the source. Returns the backup path.
 */
function writeBackup(fsOps, target, bytes, now) {
	const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
	const base = `${path.basename(target)}.abito-backup-${stamp}`;
	for (let i = 0; i < 10; i++) {
		const file = path.join(path.dirname(target), i === 0 ? base : `${base}-${i}`);
		try {
			fsOps.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
			return file;
		} catch (error) {
			if (!(error && error.code === "EEXIST")) throw error;
		}
	}
	return fail("backup name unavailable");
}

/** Creates every missing directory component below home with mode 0700. */
function ensureDirs(fsOps, home, dir) {
	assertSecurePath(dir);
	let current = home;
	for (const part of path.relative(home, dir).split(path.sep)) {
		if (part === "") continue;
		current = path.join(current, part);
		try {
			fsOps.lstatSync(current);
		} catch (error) {
			if (error && error.code === "ENOENT") fsOps.mkdirSync(current, { mode: 0o700 });
			else throw error;
		}
	}
}

/** One atomic 0600 write through the seam: temp file in the same dir, rename over. */
function atomicWrite(fsOps, target, content, suffix) {
	const tmpFile = path.join(path.dirname(target), `.${path.basename(target)}.abito-tmp-${process.pid}-${suffix}`);
	fsOps.writeFileSync(tmpFile, content, { flag: "wx", mode: 0o600 });
	if (fsOps.readFileSync(tmpFile, "utf8") !== content) fail("write verification failed");
	fsOps.renameSync(tmpFile, target);
}

/** Restores every backup and removes files the operation created. Never throws twice. */
function restoreAll(fsOps, backups, created) {
	for (const file of created) {
		try {
			fsOps.unlinkSync(file);
		} catch {}
	}
	for (const { target, backup } of backups) {
		try {
			fsOps.copyFileSync(backup, target);
		} catch (error) {
			return error;
		}
	}
	return undefined;
}

/**
 * Applies one plan's targets ({rel, abs, before, after, action}). All-or-nothing:
 * backups are taken for everything that exists and will change, writes/deletes run,
 * results are verified, and any failure restores the backups before rethrowing.
 */
function applyTargets(fsOps, home, targets, now) {
	const backups = [];
	const created = [];
	for (const target of targets) {
		if (target.action !== "create") continue;
		ensureDirs(fsOps, home, path.dirname(target.abs));
	}
	for (const target of targets) {
		if (target.action === "create") continue; // nothing to back up
		backups.push({ target: target.abs, backup: writeBackup(fsOps, target.abs, target.before, now) });
	}
	try {
		let n = 0;
		for (const target of targets) {
			const suffix = `${n++}`;
			if (target.action === "delete") fsOps.unlinkSync(target.abs);
			else {
				if (target.action === "create") created.push(target.abs);
				atomicWrite(fsOps, target.abs, target.after, suffix);
			}
		}
	} catch (error) {
		const restoreError = restoreAll(fsOps, backups, created);
		throw restoreError ?? error;
	}
	for (const target of targets) {
		const read = readTarget(fsOps, target.abs);
		if (target.action === "delete") {
			if (!read.absent) fail("remove verification failed");
		} else if (read.text !== target.after) {
			fail("write verification failed");
		}
	}
	for (const dir of MANAGED_DIRS) {
		try {
			fsOps.rmdirSync(path.join(home, dir));
		} catch {}
	}
	return backups;
}

/** Shared install/remove body: recompute the plan from scratch, bind the hash, apply. */
function mutate(options, action) {
	const ctx = context(options);
	const { clientId, planHash } = options;
	if (!CLIENT_IDS.includes(clientId) || typeof planHash !== "string" || !HASH.test(planHash)) {
		return { ok: false, code: "bad_request" };
	}
	return withOp(clientId, () => {
		const entry = scanClient(clientId, ctx.fsOps, ctx.home, ctx.platform, ctx.nodeExe);
		const plan = entry[action];
		if (plan === null) return { ok: false, code: entry.detail ?? "unavailable", client: entry };
		if (plan.plan_hash !== planHash) return { ok: false, code: "plan_changed", client: entry };
		if (!plan.changed) return { ok: true, changed: false, client: entry };
		const fresh = readArtifacts(ctx.fsOps, ctx.home, ctx.nodeExe, clientId);
		if (fresh.problem) return { ok: false, code: fresh.problem, client: entry };
		const targets = targetsOf(ctx.fsOps, ctx.home, ctx.nodeExe, clientId, action, fresh.built, fresh.reads);
		if (targets === undefined) return { ok: false, code: "unsafe_target", client: scanClient(clientId, ctx.fsOps, ctx.home, ctx.platform, ctx.nodeExe) };
		try {
			applyTargets(ctx.fsOps, ctx.home, targets, ctx.now);
		} catch {
			ctx.log(`agent hooks ${action} failed`);
			return { ok: false, code: "write_failed", client: scanClient(clientId, ctx.fsOps, ctx.home, ctx.platform, ctx.nodeExe) };
		}
		return { ok: true, changed: true, client: scanClient(clientId, ctx.fsOps, ctx.home, ctx.platform, ctx.nodeExe) };
	});
}

/**
 * Install: recomputes the plan from scratch and refuses unless `planHash` is exactly
 * the hash of the fresh install plan. Nothing is written on any refusal.
 */
function installAgentHook(options = {}) {
	return mutate(options, "install");
}

/**
 * Remove: same hash binding as install, for the remove plan. Only marker-tagged files
 * are deleted; the shared notify script stays while another dependent client uses it.
 */
function removeAgentHook(options = {}) {
	return mutate(options, "remove");
}

// ----- composed service (harness clients + native clients) -------------------------------

// copilot-cli and opencode moved to the harness installer (they now ANSWER permissions, not only notify). Their notify-only native
// adapters stay below for the module API/tests, but the composed service never shows or drives them, so nothing owns a file twice.
const HARNESS_IDS = Object.freeze(["claude-code", "codex", "statusline", "copilot-cli", "opencode"]);
/** The full closed catalogue, in presentation order. */
const CATALOGUE_IDS = Object.freeze([...new Set([...HARNESS_IDS, ...CLIENT_IDS])]);

/** Maps an AgentsManager entry (claude-code / codex) into the catalogue entry shape. */
function harnessEntry(a) {
	const hasPlan = typeof a.plan_hash === "string";
	return {
		id: a.id,
		name: a.name,
		mechanism: "harness",
		state: a.state,
		detail: a.detail ?? null,
		backup: a.backup === true,
		install: hasPlan ? { plan_hash: a.plan_hash, changed: true, summary: a.summary ?? "", reviewable: a.reviewable === true, diff: { lines: [], hidden: 0 } } : null,
		// agent_disconnect carries no plan hash (existing AgentsManager contract, untouched).
		remove: a.state === "connected" || a.state === "outdated" ? { changed: true, summary: `Removes the Abito hooks of ${a.name}. A backup is made first.`, reviewable: true, diff: { lines: [], hidden: 0 } } : null,
	};
}

/**
 * The catalogue service the daemon exposes: preview (read-only), install and remove
 * (explicit, hash-bound). claude-code and codex are delegated to the AgentsManager
 * (its code is untouched); the other four use the native adapters above.
 */
function createAgentHooks(options = {}) {
	const { agents } = options;
	const native = () => ({ home: options.home, platform: options.platform, nodeExe: options.nodeExe ?? process.execPath, fs: options.fs, now: options.now, log: options.log });
	const preview = async () => {
		const harness = [];
		if (agents) {
			for (const a of await agents.list()) if (HARNESS_IDS.includes(a.id)) harness.push(harnessEntry(a));
		}
		return { clients: [...harness, ...scanAgentHooks(native()).clients.filter((c) => !HARNESS_IDS.includes(c.id))] };
	};
	const finish = async (clientId, action, result) => ({ clients: (await preview()).clients, result: { clientId, action, ok: result.ok === true, ...(result.ok === true ? {} : { code: result.code ?? "failed" }) } });
	const run = async (action, clientId, planHash) => {
		const hashOk = typeof planHash === "string" && HASH.test(planHash);
		if (!CATALOGUE_IDS.includes(clientId) || (planHash !== undefined && !hashOk)) return finish(clientId, action, { ok: false, code: "bad_request" });
		if (HARNESS_IDS.includes(clientId)) {
			if (!agents) return finish(clientId, action, { ok: false, code: "unavailable" });
			if (action === "install" && !hashOk) return finish(clientId, action, { ok: false, code: "bad_request" });
			try {
				const entries = action === "install" ? await agents.connect(clientId, planHash) : await agents.disconnect(clientId);
				const entry = entries.find((e) => e.id === clientId);
				const bad = entry && entry.state === "error";
				return finish(clientId, action, bad ? { ok: false, code: entry.detail === "plan_changed" ? "plan_changed" : "failed" } : { ok: true });
			} catch (error) {
				return finish(clientId, action, { ok: false, code: error?.code === "busy" ? "busy" : "failed" });
			}
		}
		const fn = action === "install" ? installAgentHook : removeAgentHook;
		return finish(clientId, action, fn({ ...native(), clientId, planHash }));
	};
	return { preview, install: (id, hash) => run("install", id, hash), remove: (id, hash) => run("remove", id, hash) };
}

module.exports = { SCHEMA, CLIENT_IDS, CATALOGUE_IDS, HARNESS_IDS, MARKER, LEGACY_MARKER, LEGACY_RELS, LEGACY_SCRIPT_REL, SCRIPT_REL, scanAgentHooks, installAgentHook, removeAgentHook, createAgentHooks };

"use strict";

/**
 * Agent hook manager (H2b): lets the island connect/disconnect the Abito hooks of Claude Code and
 * Codex with a button. The daemon DRIVES the installer CLI of apps/desktop-harness
 * (`bin/abito-hook.cjs install <harness> --user ... --json`, see that package's
 * docs/ISLAND-INSTALL.md) as a subprocess and REBUILDS every answer from a closed vocabulary.
 *
 * PROTOCOL INVARIANTS (also in docs/PROTOCOL.md and the README):
 *  - agent_connect / agent_disconnect (and later connectors_connect/disconnect/mode) are reachable
 *    ONLY through the authenticated island-agent/1 channel. There is NO MCP tool, engine tool or CLI
 *    path that reaches this class. They count toward the per-client rate limit and every apply is
 *    audited by the installer (`<island>/audit/hook-installs.jsonl`, metadata only, no content).
 *  - HONEST same-uid limit: the channel token lives in <island>/runtime/session.json (0600), so any
 *    process of the same user that can read it (Abito's own engine agent, Claude Code, Codex...) can
 *    send these frames. Closing that needs the daemon launched by the island with an inherited
 *    socket (security follow-up, NOT done).
 *  - "The plan shown when the button appeared" is what gets applied: agent_connect may carry the
 *    plan_hash the island displayed; a different fresh plan => error/plan_changed, nothing applied.
 *
 * The installer is spawned as [nodeExe, installerBin, ...args], shell:false, in its own process
 * group (group SIGKILL on timeout), stdout capped, stderr drained and never surfaced, with an
 * ALLOWLISTED environment (PATH, HOME = the REAL home, LANG) plus ABITO_ISLAND_EXE=<realpath of
 * nodeExe>: the daemon IS the authenticated caller, so installer guard (i) ("the parent is the
 * island executable") becomes "the parent is the daemon's node". No agent markers, PI_* or provider
 * variables are inherited, which also satisfies guard (ii).
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { assertSecurePath } = require("./isolation.cjs");

const SCHEMA = "abito-hook-install/1";
const DEFAULTS = Object.freeze({ timeoutMs: 10_000, maxBytes: 256 * 1024, cacheMs: 1000 });
const HASH = /^[0-9a-f]{64}$/;
const CHILD_PATH = "/usr/bin:/bin";
const MAX_DIR_ENTRIES = 5000;
const EVENTS = Object.freeze(["PermissionRequest", "Stop"]);
// What the Claude installer reports today (also answers AskUserQuestion through PermissionRequest and caches the session
// title). The summary the human reads keeps naming the two events it is about; the preview is validated against the full
// list, in the installer's order. S2/T1: AskUserQuestion no longer has its own PreToolUse entry, so that event only ever
// shows up as a trailing MIGRATION entry, and only on the run that actually removes the old entry we owned.
const CLAUDE_EVENTS = Object.freeze(["PermissionRequest", "SessionStart", "Stop"]);
const MIGRATED_EVENTS = Object.freeze(["PreToolUse"]);
// S4/T2: the Codex installer (notice-only) reports four entries, in this order.
const CODEX_EVENTS = Object.freeze(["PermissionRequest", "PreToolUse", "PostToolUse", "Stop"]);
const FOLDER_REASONS = new Set(["writable", "foreign_owner", "acl"]);
const OPS = new Set(["add", "replace", "remove", "keep"]);
/** Installer refusal codes we map; everything else is the generic install_failed. */
const REFUSAL_DETAIL = Object.freeze({
	not_writable: "not_writable",
	unsafe_folder: "unsafe_folder", // HU-047: a folder another user/group can change (or that is not ours); carries folder + folder_reason
	foreign_extension: "foreign_extension", // HU-052: a Pi extension folder Abito did not install
	backup_failed: "backup_failed",
	plan_changed: "plan_changed",
	audit_unavailable: "audit_unavailable",
	unsafe_target: "unsafe_target",
	install_unverified: "install_unverified",
});

const AGENTS = Object.freeze([
	Object.freeze({ id: "claude-code", name: "Claude Code", harness: "claude", dir: ".claude", file: "settings.json", events: EVENTS, wireEvents: CLAUDE_EVENTS, migratedEvents: MIGRATED_EVENTS }),
	Object.freeze({ id: "codex", name: "Codex", harness: "codex", dir: ".codex", file: "hooks.json", events: EVENTS, wireEvents: CODEX_EVENTS }),
	Object.freeze({ id: "recap", name: "Resumen semanal", harness: "recap", dir: ".claude", file: "settings.json", events: Object.freeze(["UserPromptSubmit", "PostToolUse", "Stop"]) }),
	Object.freeze({ id: "statusline", name: "Uso del plan (relay)", harness: "statusline", dir: ".claude", file: "settings.json", events: Object.freeze(["statusLine"]) }),
	// Copilot CLI: the hooks file Abito owns under ~/.copilot/hooks; OpenCode: the plugin Abito owns under ~/.config/opencode/plugins.
	// Both answer permissions from the island and notify on session end (apps/desktop-harness install copilot|opencode).
	Object.freeze({ id: "copilot-cli", name: "Copilot CLI", harness: "copilot", dir: ".copilot/hooks", file: "abito-island.json", events: Object.freeze(["permissionRequest", "sessionEnd"]) }),
	Object.freeze({ id: "opencode", name: "OpenCode", harness: "opencode", dir: ".config/opencode/plugins", file: "abito-island.js", events: Object.freeze(["permission.ask", "event"]) }),
	Object.freeze({ id: "pi", name: "Pi", harness: "pi", dir: ".pi/agent/extensions", file: "abito-island", events: Object.freeze(["extension"]) }),
]);

/** The only error type thrown to callers; `code` is a protocol error code (busy, bad_request). */
class AgentsError extends Error {
	constructor(code) {
		super(code === "busy" ? "agents busy" : "agents request invalid");
		this.name = "AgentsError";
		this.code = code;
	}
}
const fail = () => {
	throw new Error("installer output rejected");
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Use-time trust check of the installer script (run before EVERY spawn; the file may change):
 * absolute normalized path, a regular NON-symlink file owned by the user or root, not
 * group/world-writable, secure parent chain (no symlink components, no foreign owners, no
 * world-writable-without-sticky dirs). It is run with node, so it needs no exec bit.
 */
function assertTrustedScript(file, platform = process.platform, verifyBundled = defaultVerifyBundled) {
	if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file) fail();
	if (platform === "win32") {
		// No POSIX owner/mode bits on Windows: the bytes must match the install manifest (HU-047).
		verifyBundled(file);
		return;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	assertSecurePath(path.dirname(file));
	const st = fs.lstatSync(file);
	if (st.isSymbolicLink() || !st.isFile()) fail();
	if (uid !== undefined && st.uid !== uid && st.uid !== 0) fail();
	if ((st.mode & 0o022) !== 0) fail();
}

/** Windows only: the harness verifies the script against the install manifest (sibling package of this install). */
function defaultVerifyBundled(file) {
	require("../../desktop-harness/src/win-fs.cjs").verifyBundled(file);
}

/** SIGKILL the child's whole process group (it is its own leader); ESRCH is fine. */
function killGroup(child) {
	if (!child || !Number.isInteger(child.pid) || child.pid <= 1) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
}

/**
 * HU-047 L4: on Windows the installer (node) starts the native helper, so killing only node leaves it running. `taskkill /T /F`
 * on the still-live installer takes the whole tree. `run` is injectable for tests; never throws, never uses a shell.
 */
function killTree(child, platform = process.platform, run = require("node:child_process").spawnSync) {
	if (platform !== "win32" || !child || !Number.isInteger(child.pid) || child.pid <= 4) return;
	try {
		const root = process.env.SystemRoot && /^[A-Za-z]:\\/.test(process.env.SystemRoot) ? process.env.SystemRoot : "C:\\Windows";
		run(`${root}\\System32\\taskkill.exe`, ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 5000 });
	} catch {}
}

/** Exactly one JSON object on one line (a single trailing LF allowed), valid UTF-8. */
function parseLine(buffer) {
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	const line = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
	if (line === "" || line.includes("\n") || line.includes("\r")) fail();
	const value = JSON.parse(line);
	if (!isObject(value)) fail();
	return value;
}

class AgentsManager extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} [options.installerBin]  ABSOLUTE path of apps/desktop-harness/bin/abito-hook.cjs; unset => every agent unavailable
	 * @param {string} [options.nodeExe]       node executable that runs the installer (default process.execPath)
	 * @param {string} options.home            the REAL home (the installer's --user target); passed as HOME to the child
	 * @param {string} options.islandDir       island root; audit goes to <islandDir>/audit
	 * @param {number} [options.timeoutSec]    forwarded as --timeout-sec when set
	 * @param {number} [options.timeoutMs]     hard timeout per installer call (default 10 s)
	 * @param {number} [options.maxBytes]      stdout/stderr cap (default 256 KiB)
	 * @param {(argv:string[], env:object)=>Promise<{exit:number, stdout:Buffer}>} [options.run]  test seam replacing the spawn
	 * @param {()=>number} [options.now]
	 * @param {(line:string)=>void} [options.log]  fixed strings only
	 */
	constructor(options) {
		super();
		this.installerBin = options.installerBin;
		this.platform = options.platform ?? process.platform;
		this.verifyBundled = options.verifyBundled ?? defaultVerifyBundled;
		this.nodeExe = options.nodeExe ?? process.execPath;
		this.home = options.home;
		this.islandDir = options.islandDir;
		this.timeoutSec = options.timeoutSec;
		this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
		this.runner = options.run ?? ((argv, env) => this.spawnInstaller(argv, env));
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.op = undefined; // the single global in-flight operation: {id}
		this.cache = undefined; // {at, entries}
		this.last = undefined; // last full list (any age), reused for agents an operation does not touch
		this.flight = undefined;
	}

	get available() {
		return typeof this.installerBin === "string" && this.installerBin !== "";
	}

	invalidate() {
		this.cache = undefined;
	}

	// ----- public API ----------------------------------------------------------------

	/** The agent list. Cached 1 s; concurrent calls share one computation; during an operation the working agent reads `working`. */
	async list() {
		if (this.op) return this.duringOperation();
		const cached = this.cache;
		if (cached && this.now() - cached.at < DEFAULTS.cacheMs) return clone(cached.entries);
		if (!this.flight) {
			const flight = Promise.all(AGENTS.map((agent) => this.entry(agent))).then(
				(entries) => {
					this.flight = undefined;
					this.remember(entries);
					return entries;
				},
				(error) => {
					this.flight = undefined;
					throw error;
				},
			);
			this.flight = flight;
		}
		return clone(await this.flight);
	}

	connect(id, planHash) {
		return this.operate(id, planHash, false);
	}

	disconnect(id) {
		return this.operate(id, undefined, true);
	}

	// ----- operations ----------------------------------------------------------------

	async operate(id, planHash, remove) {
		const agent = AGENTS.find((a) => a.id === id);
		if (!agent || (planHash !== undefined && !HASH.test(planHash))) throw new AgentsError("bad_request");
		if (!remove && ["recap", "statusline"].includes(id) && planHash === undefined) throw new AgentsError("bad_request");
		if (!["linux", "darwin", "win32"].includes(this.platform)) return this.list();
		if (!agent.harness || !this.available) return this.list(); // nothing to run: the agent reads unavailable
		if (this.op) throw new AgentsError("busy");
		this.op = { id: agent.id };
		this.cache = undefined;
		try {
			const others = await this.others(agent.id);
			this.emitChange(merge(others, agent.id, workingEntry(agent)));
			let entry;
			try {
				entry = await this.apply(agent, planHash, remove);
			} catch {
				this.log("agent operation failed");
				entry = this.failure(agent, "install_failed");
			}
			const final = merge(await this.others(agent.id), agent.id, entry);
			this.remember(final);
			return clone(final);
		} finally {
			this.op = undefined;
		}
	}

	/** preview -> (optional) plan check -> apply-plan. Returns the resulting entry. Throws on any unexpected output. */
	async apply(agent, planHash, remove) {
		const pv = await this.inspect(agent, remove);
		if (pv.entry) return pv.entry;
		const preview = pv.preview;
		if (remove) {
			if (!preview.changed) return this.entry(agent); // nothing to remove
		} else {
			const state = stateOf(preview);
			if (state === "connected") return this.fromPreview(agent, preview);
			if (planHash !== undefined && planHash !== preview.plan_hash) {
				// What the human saw is not what would be written now: apply NOTHING, hand back the fresh plan.
				return { ...this.fromPreview(agent, preview), state: "error", detail: "plan_changed" };
			}
		}
		const result = await this.call(agent, applyArgs(this, agent, remove, preview.plan_hash));
		if (!result.ok) return this.refusalEntry(agent, result.code, result);
		const json = result.json;
		if (json.mode !== "applied" || json.plan_hash !== preview.plan_hash || json.harness !== agent.harness || json.action !== (remove ? "remove" : "install")) fail();
		if (typeof json.changed !== "boolean") fail();
		if (remove) {
			const fresh = await this.entry(agent); // new plan_hash for the next Connect click
			return { ...fresh, backup: json.changed ? true : fresh.backup };
		}
		const connected = { id: agent.id, name: agent.name, state: "connected", backup: json.changed ? true : this.backupExists(agent), detail: null };
		// Codex keeps the new hooks inactive until the human trusts them in /hooks: remind right after connecting.
		return agent.harness === "codex" ? { ...connected, trust_review: true } : connected;
	}

	// ----- state -----------------------------------------------------------------------

	remember(entries) {
		this.last = entries;
		this.cache = { at: this.now(), entries };
	}

	/** Entries of every agent except `exceptId`, from the last known list when there is one. */
	async others(exceptId) {
		const known = new Map((this.last ?? []).map((e) => [e.id, e]));
		const out = [];
		for (const agent of AGENTS) {
			if (agent.id === exceptId) continue;
			out.push(known.get(agent.id) ?? (await this.entry(agent)));
		}
		return out;
	}

	async duringOperation() {
		const id = this.op.id;
		const agent = AGENTS.find((a) => a.id === id);
		return clone(merge(await this.others(id), id, workingEntry(agent)));
	}

	emitChange(entries) {
		try {
			this.emit("change", clone(entries));
		} catch {
			this.log("agents listener failed");
		}
	}

	/** The state entry of one agent (read-only preview). Never throws. */
	async entry(agent) {
		if (!["linux", "darwin", "win32"].includes(this.platform)) return this.plain(agent, "unavailable", "unsupported_platform");
		if (!agent.harness || !this.available) return this.plain(agent, "unavailable");
		try {
			const pv = await this.inspect(agent, false);
			return pv.entry ?? this.fromPreview(agent, pv.preview);
		} catch {
			this.log("agent preview failed");
			return this.failure(agent, "install_failed");
		}
	}

	plain(agent, state, detail = null) {
		return { id: agent.id, name: agent.name, state, backup: state === "unavailable" ? false : this.backupExists(agent), detail };
	}

	failure(agent, detail) {
		return this.plain(agent, "error", detail);
	}

	/** Maps an installer refusal code to a terminal entry. */
	refusalEntry(agent, code, extra) {
		if (code === "refused") {
			// The CLI refuses every unreadable/invalid input with the same fixed text; a missing settings dir means "tool not installed".
			return this.settingsDirExists(agent) ? this.failure(agent, "config_invalid") : this.plain(agent, "unavailable");
		}
		if (code === "unsafe_folder") {
			const entry = this.failure(agent, "unsafe_folder");
			if (typeof extra?.folder === "string" && FOLDER_REASONS.has(extra.folder_reason) && [...extra.folder].length <= 400) {
				entry.folder = extra.folder;
				entry.folder_reason = extra.folder_reason;
			}
			return entry;
		}
		return this.failure(agent, REFUSAL_DETAIL[code] ?? "install_failed");
	}

	/** Preview call. Returns {entry} for a terminal outcome or {preview} (validated). Throws on garbage. */
	async inspect(agent, remove) {
		const result = await this.call(agent, previewArgs(this, agent, remove));
		if (!result.ok) return { entry: this.refusalEntry(agent, result.code, result) };
		return { preview: readPreview(result.json, agent, remove, this.targetOf(agent)) };
	}

	fromPreview(agent, preview) {
		const state = stateOf(preview);
		const entry = { id: agent.id, name: agent.name, state, backup: this.backupExists(agent), detail: null };
		if (state === "connected") return entry;
		const reviewable = preview.diff.hidden === 0 && preview.diff.lines.every((line) => line.length < 300 && !line.includes("?"));
		const trust = agent.harness === "codex";
		const file = `~/${agent.dir}/${agent.file}`;
		let summary =
			state === "outdated"
				? `Updates the Abito hooks in ${file}. A backup is made first.`
				: `Adds the Abito hooks (${agent.events.join(", ")}) to ${file}. A backup is made first.`;
		if (agent.id === "pi") summary = "Installs the Abito Pi extension in the default ~/.pi/agent directory. A backup is made first.";
		if (agent.id === "opencode") summary = state === "outdated" ? `Updates the Abito plugin in ${file}. A backup is made first.` : `Adds the Abito plugin to ${file}. A backup is made first.`;
		if (agent.id === "recap") summary = "Adds notify-only hooks that only count activity for the weekly recap. No command text, path or prompt is kept. A backup is made first.";
		if (agent.id === "statusline") summary = "Adds the status-line relay in ~/.claude/settings.json. An existing status line keeps working (the relay prints it). A backup is made first.";
		if (trust) summary += " Codex will ask you to trust them in /hooks.";
		if (!reviewable) summary += " This change is large: review it in the file.";
		return { ...entry, plan_hash: preview.plan_hash, summary, reviewable, trust_review: trust };
	}

	// ----- filesystem facts (fixed names only; never file content) ---------------------------

	targetOf(agent) {
		return path.join(this.home, agent.dir, agent.file);
	}

	settingsDirExists(agent) {
		try {
			const st = fs.lstatSync(path.join(this.home, agent.dir));
			return st.isDirectory() && !st.isSymbolicLink();
		} catch {
			return false;
		}
	}

	/** True when a regular file `<target>.abito-backup-*` exists next to the target (bounded readdir). */
	backupExists(agent) {
		if (!agent.harness) return false;
		const dir = agent.id === "pi" ? path.join(this.home, ".pi/agent/abito-backups") : path.join(this.home, agent.dir);
		const prefix = `${agent.file}.abito-backup-`;
		let handle;
		try {
			handle = fs.opendirSync(dir);
			for (let i = 0; i < MAX_DIR_ENTRIES; i++) {
				const item = handle.readSync();
				if (!item) break;
				if (!item.name.startsWith(prefix)) continue;
				try {
					const st = fs.lstatSync(path.join(dir, item.name));
					if ((agent.id === "pi" ? st.isDirectory() : st.isFile()) && !st.isSymbolicLink()) return true;
				} catch {}
			}
		} catch {
			return false;
		} finally {
			try {
				handle?.closeSync();
			} catch {}
		}
		return false;
	}

	// ----- subprocess ------------------------------------------------------------------

	childEnv() {
		const env = this.platform === "win32"
			? { HOME: this.home, USERPROFILE: this.home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot, PATH: path.win32.join(process.env.SystemRoot, "System32") } : {}) }
			: { PATH: CHILD_PATH, HOME: this.home };
		if (typeof process.env.LANG === "string" && process.env.LANG !== "") env.LANG = process.env.LANG;
		env.ABITO_ISLAND_EXE = fs.realpathSync(this.nodeExe);
		return env;
	}

	/**
	 * One installer call. Resolves {ok:true, json} or {ok:false, code}; THROWS on trust failure,
	 * timeout, oversize, garbage or an exit code that disagrees with the JSON verdict.
	 */
	async call(_agent, args) {
		assertTrustedScript(this.installerBin, this.platform, this.verifyBundled);
		const { exit, stdout } = await this.runner([this.installerBin, ...args], this.childEnv());
		const json = parseLine(stdout);
		if (json.schema !== SCHEMA) fail();
		if (json.ok === true) {
			if (exit !== 0) fail();
			return { ok: true, json };
		}
		if (json.ok === false && typeof json.code === "string" && exit !== 0 && Number.isInteger(exit)) return { ok: false, code: json.code, folder: json.folder, folder_reason: json.folder_reason };
		return fail();
	}

	spawnInstaller(argv, env) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let child;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					killGroup(child);
					killTree(child, this.platform);
				}
				try {
					child?.kill("SIGKILL");
				} catch {}
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				if (error) return reject(new Error("installer failed"));
				resolve(value);
			};
			const timer = setTimeout(() => finish(true), this.timeoutMs);
			timer.unref?.();
			try {
				child = spawn(this.nodeExe, argv, {
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env,
					cwd: this.islandDir,
					detached: this.platform !== "win32", // own process group on POSIX: a timeout kills grandchildren too
					windowsHide: true,
				});
			} catch {
				return finish(true);
			}
			const chunks = [];
			let size = 0;
			let errSize = 0;
			child.on("error", () => finish(true));
			child.stdout.on("data", (chunk) => {
				size += chunk.length;
				if (size > this.maxBytes) return finish(true);
				chunks.push(chunk);
			});
			// Drained so the child never blocks on a full pipe; never stored nor surfaced.
			child.stderr.on("data", (chunk) => {
				errSize += chunk.length;
				if (errSize > this.maxBytes) finish(true);
			});
			child.on("close", (code) => finish(false, { exit: code ?? -1, stdout: Buffer.concat(chunks) }));
		});
	}
}

// ----- argv ------------------------------------------------------------------------------

function baseArgs(manager, agent, remove) {
	const args = ["install", agent.harness, "--user"];
	if (manager.timeoutSec !== undefined && agent.harness === "claude") args.push("--timeout-sec", String(manager.timeoutSec));
	if (remove) args.push("--remove");
	return args;
}
const previewArgs = (manager, agent, remove) => [...baseArgs(manager, agent, remove), "--json"];
const applyArgs = (manager, agent, remove, hash) => [...baseArgs(manager, agent, remove), "--apply-plan", hash, "--audit-dir", path.join(manager.islandDir, "audit"), "--json"];

// ----- validation / mapping -------------------------------------------------------------------

/** Rebuilds the preview from the CLI answer; throws on anything off-contract. */
function readPreview(json, agent, remove, target) {
	if (json.mode !== "preview" || json.harness !== agent.harness || json.action !== (remove ? "remove" : "install")) fail();
	if (json.target !== target || typeof json.changed !== "boolean" || typeof json.plan_hash !== "string" || !HASH.test(json.plan_hash)) fail();
	const wire = agent.wireEvents ?? agent.events;
	const migrated = agent.migratedEvents ?? [];
	if (!Array.isArray(json.entries)) fail();
	// The rows naming our wire events must be there, in the installer's order. Any OTHER row is informational and is
	// accepted only when it names an event we merely migrate away from (nothing else is installed there); state comes
	// from the wire rows alone.
	const entries = [], extra = [];
	for (const e of json.entries) {
		if (!isObject(e) || !OPS.has(e.op) || typeof e.event !== "string") fail();
		(wire.includes(e.event) ? entries : extra).push({ event: e.event, op: e.op });
	}
	if (entries.length !== wire.length || entries.some((e, i) => e.event !== wire[i])) fail();
	if (extra.some((e) => !migrated.includes(e.event))) fail();
	const diff = json.diff;
	if (!isObject(diff) || !Array.isArray(diff.lines) || diff.lines.length > 200 || diff.lines.some((l) => typeof l !== "string")) fail();
	if (!Number.isInteger(diff.hidden) || diff.hidden < 0) fail();
	// A migrated row that still has work to do (op "remove") makes the install outdated even when every wire row keeps.
	const migrating = extra.some((e) => e.op !== "keep");
	return { changed: json.changed, plan_hash: json.plan_hash, entries, migrating, diff: { lines: diff.lines, hidden: diff.hidden } };
}

/** Install-preview state: all keep => connected; any replace (or partial) => outdated; all add => not_connected. */
function stateOf(preview) {
	const ops = preview.entries.map((e) => e.op);
	if (ops.every((op) => op === "keep")) {
		if (preview.migrating) return "outdated";
		if (preview.changed) fail();
		return "connected";
	}
	if (ops.every((op) => op === "add")) return "not_connected";
	return "outdated";
}

const workingEntry = (agent) => ({ id: agent.id, name: agent.name, state: "working", backup: false, detail: null });
const merge = (others, id, entry) => AGENTS.map((a) => (a.id === id ? entry : others.find((o) => o.id === a.id)));
const clone = (entries) => entries.map((e) => ({ ...e }));

module.exports = { AGENTS, AgentsError, AgentsManager, assertTrustedScript, killTree };

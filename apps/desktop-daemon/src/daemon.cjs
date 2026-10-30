"use strict";

/**
 * Abito island daemon (U4): composes the supervised engine (runtime.cjs), the
 * account manager (auth.cjs), the profile store (profiles.cjs) and the island
 * server (server.cjs) from `<island>/config.json`.
 *
 * Host handoff: after everything is up, `<island>/runtime/session.json`
 * (0600, atomic) carries `{protocol, endpoint, token, pid, procStart, startedAt}`. The
 * token is generated per launch, lives only in memory and that file, and is
 * never logged. The file is removed on stop.
 */

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { AccountManager } = require("./auth.cjs");
const config = require("./config.cjs");
const { scanMcpConfigs, validateHome } = require("./mcp-import.cjs");
const { createAgentHooks } = require("./agent-hooks.cjs");
const { ConnectorsControl, ConnectorsView } = require("./connectors.cjs");
const { AgentsManager } = require("./agents.cjs");
const { ConnectorHostSupervisor } = require("./connector-host.cjs");
const { ensureIsland, ensurePrivateDir, islandPaths, writePrivateFile, windowsIslandRootViolation } = require("./isolation.cjs");
const { ProfileStore } = require("./profiles.cjs");
const { scanSessions, sessionScope } = require("./sessions.cjs");
const { runPs } = require("./procinfo.cjs");
const { AgentEngine } = require("./runtime.cjs");
const { defaultIslandRoot } = require("./isolation.cjs");
// #386: continuous conversation rotation (opt-in via config `rotation`).
const { SessionRotator } = require("./rotation.cjs");
const { IslandServer } = require("./server.cjs");

const PROTOCOL = "island-agent/1";
const SESSION_FILE = "session.json";
/** What a daemon process's command line contains (Linux /proc ownership check). */
const DAEMON_CMDLINE = /(abito-island-daemon|cli\.cjs)/;

/** stdin size bound and timeout for the native session helper (Windows). */
const SESSION_HELPER_LIMIT = 4096;
const SESSION_HELPER_TIMEOUT_MS = 5000;

/**
 * Fixed sibling locations of the native Windows session helper
 * (`abito-private-session.exe`, L6). Never PATH, never the working directory:
 * the helper is found exactly where the repo layout or the installer puts it.
 * Empty off Windows.
 */
function sessionHelperCandidates(srcDir = __dirname) {
	if (process.platform !== "win32") return [];
	// Installed layout only: the helper ships next to the daemon package root, and findSessionHelper additionally
	// requires its sha256 to match abito-install.json (HU-047 M2). No development build is ever a candidate.
	return [path.resolve(srcDir, "..", "..", "abito-private-session.exe")];
}

/** The first existing helper candidate, or undefined (fail closed). */
function findSessionHelper(deps = {}) {
	if (process.platform !== "win32") return undefined;
	// One resolver shared with the hook installer: verified against the install manifest, never PATH/cwd/dev build.
	return (deps.resolveHelper ?? require("../../desktop-harness/src/win-fs.cjs").resolveHelper)();
}

/**
 * Windows (L6): session.json carries the launch token, and Node cannot set a
 * Windows ACL — so the file is written by the native helper, which creates the
 * temp file with an explicit protected owner-only DACL AT CREATION and replaces
 * the target atomically. The token travels on the helper's STDIN only: never
 * argv, never the environment, never a log. The daemon root is passed as
 * ABITO_ISLAND_DIR (the same var the daemon itself honours); the helper refuses
 * any root that bypasses the canonical protected %LOCALAPPDATA%\Abito root.
 * Fails closed: without the helper or without a zero exit, NO session is
 * published and the boot fails.
 */
function publishSessionWindows(root, payload, deps = {}) {
	const spawnSync = deps.spawnSync ?? require("node:child_process").spawnSync;
	const exe = deps.helperPath ?? findSessionHelper(deps);
	if (!exe) throw new Error("native session helper not found (abito-private-session.exe)");
	const input = Buffer.from(JSON.stringify(payload), "utf8");
	if (input.length > SESSION_HELPER_LIMIT) throw new Error("session payload over the helper size bound");
	const result = spawnSync(exe, [], {
		input,
		timeout: SESSION_HELPER_TIMEOUT_MS,
		windowsHide: true,
		env: { ...process.env, ABITO_ISLAND_DIR: path.resolve(root) },
	});
	if (result.error) throw new Error("native session helper failed to run");
	if (result.status !== 0) throw new Error("native session helper refused the session");
	return true;
}

/** Read-only native ACL/server identity/ready proof. No token leaves Node. */
function verifySessionWindows(root, deps = {}) {
    const exe = deps.helperPath ?? findSessionHelper(deps);
    if (!exe) return false;
    try {
        const result = (deps.spawnSync ?? require("node:child_process").spawnSync)(exe, ["--verify"], {
            timeout: SESSION_HELPER_TIMEOUT_MS, windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4096,
            env: { ...process.env, ABITO_ISLAND_DIR: path.resolve(root) },
        });
        return !result.error && result.status === 0 && !result.stdout?.length && !result.stderr?.length;
    } catch { return false; }
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function sessionPath(root) {
	return path.join(path.resolve(root), "runtime", SESSION_FILE);
}

/** Strictly parsed handoff file, or undefined when absent/unsafe/malformed. */
function readSession(root) {
	const file = sessionPath(root);
	try {
		const stats = fs.lstatSync(file);
		if (!stats.isFile() || stats.isSymbolicLink() || (process.platform !== "win32" && (stats.mode & 0o077) !== 0) || stats.size > 4096) return undefined;
		if (uid() !== undefined && stats.uid !== uid()) return undefined;
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value?.protocol !== PROTOCOL || typeof value.endpoint !== "string" || typeof value.token !== "string") return undefined;
		if (!Number.isInteger(value.pid) || value.pid <= 1 || typeof value.startedAt !== "number") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Raw start time of `pid` in clock ticks since boot (field 22 of
 * /proc/<pid>/stat; boot-time independent), as a decimal string. `undefined`
 * when /proc is unavailable or unreadable: callers fail closed.
 */
function procStartTicks(pid) {
	if (process.platform === "darwin") return runPs(pid)?.start;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces/parens: parse after the LAST ")". Field 3 is index 0.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = fields[22 - 3];
		return /^[0-9]+$/.test(ticks ?? "") ? ticks : undefined;
	} catch {
		return undefined;
	}
}

/** "dead" (confirmed gone or zombie), "alive" (confirmed live), "unknown" (cannot confirm: never signal). */
function pidState(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return error.code === "ESRCH" ? "dead" : "unknown";
	}
	if (process.platform === "darwin") {
		const info = runPs(pid);
		return info === undefined ? "unknown" : info.state === "Z" ? "dead" : "alive";
	}
	// Windows has no /proc: a pid that answers signal 0 is alive. Identity is NEVER inferred from it
	// (isDaemonProcess stays false there), so this cannot authorise signalling a foreign process.
	if (process.platform === "win32") return "alive";
	try {
		// An exited-but-unreaped child (zombie) is not alive for our purposes.
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z" ? "dead" : "alive";
	} catch {
		return "unknown";
	}
}

/** Fail closed: true only when the process is confirmed alive. */
function pidAlive(pid) {
	return pidState(pid) === "alive";
}

/**
 * True only for a confirmed-live process of the current user whose recorded
 * start time (`procStart`, written into session.json by the daemon itself)
 * equals its /proc start time AND whose command line looks like this daemon.
 * Fails closed on every missing or unreadable piece (including no /proc).
 */
function isDaemonProcess(pid, procStart) {
	if (process.platform === "win32") return false; // no /proc identity: fail closed (never signal on a bare pid)
	if (typeof procStart !== "string" || !/^[0-9]+$/.test(procStart)) return false;
	if (!pidAlive(pid)) return false;
	if (procStartTicks(pid) !== procStart) return false;
	if (process.platform === "darwin") {
		const info = runPs(pid);
		return info !== undefined && uid() !== undefined && info.uid === uid() && DAEMON_CMDLINE.test(info.command);
	}
	const proc = `/proc/${pid}`;
	try {
		if (uid() !== undefined && fs.statSync(proc).uid !== uid()) return false;
		return DAEMON_CMDLINE.test(fs.readFileSync(`${proc}/cmdline`, "utf8"));
	} catch {
		return false;
	}
}

/** Field 4 of `/proc/<pid>/stat` (ppid) or undefined when the pid is gone/unreadable. */
function ppidOf(pid) {
	if (process.platform === "darwin") return runPs(pid)?.ppid;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return /^[0-9]+$/.test(fields[1] ?? "") ? Number(fields[1]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * GD014 readiness probe: hello the session's endpoint and wait for the first
 * frame. "ready" only when the daemon itself answers `ready` to OUR token;
 * a missing socket, a closed connection, a foreign token or a timeout is
 * "refused". Never throws; the default bound keeps a hung socket from hanging the caller.
 */
function probeEndpoint(session, timeoutMs = 1000) {
	return new Promise((resolve) => {
		let socket;
		try {
			socket = net.connect(session.endpoint);
		} catch {
			return resolve("refused");
		}
		let buf = "";
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {}
			resolve(value);
		};
		socket.setTimeout(timeoutMs, () => done("refused"));
		socket.on("error", () => done("refused"));
		socket.on("close", () => done("refused"));
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			const i = buf.indexOf("\n");
			if (i < 0) return;
			try {
				done(JSON.parse(buf.slice(0, i)).type === "ready" ? "ready" : "refused");
			} catch {
				done("refused");
			}
		});
		socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL, token: session.token })}\n`));
	});
}

/**
 * GD014 — read-only launch-state classification of `<root>/runtime/session.json`:
 *
 *   stale     no session, an unsafe/malformed file, a dead pid, a recycled pid,
 *             or a confirmed daemon whose endpoint refuses
 *   foreign   a live pid that is not this daemon: another command, or a start
 *             time the session cannot confirm
 *   orphaned  a confirmed daemon whose parent is gone (ppid 1, or reparented
 *             away from the boot-time ppid recorded in session.json)
 *   healthy   a confirmed daemon with a live parent whose endpoint answers ready
 *
 * Every verdict carries an explicit `reason` and the hello→ready probe result
 * (`ready`). Never writes, never creates directories. `deps.ppid` is a test
 * seam: no live test can make a child of its own process reparent to pid 1.
 */
async function classifySession(root, deps = {}) {
	const ppid = deps.ppid ?? ppidOf;
	if (!fs.existsSync(sessionPath(root))) return { state: "stale", reason: "no_session" };
	const session = readSession(root);
	if (!session) return { state: "stale", reason: "bad_session" };
	// Probe BEFORE trusting anything else: even a dead recorded pid must never
	// hide a live endpoint (GD029: never overwrite a session that answers ready).
	const platform = deps.platform ?? process.platform;
	// Windows never sends the token through the unverified Node probe. The
	// native helper checks file ACL + pipe server pid/SID before hello→ready.
	const ready = platform === "win32"
		? (deps.nativeVerify ?? verifySessionWindows)(root) === true
		: (await probeEndpoint(session)) === "ready";
	if (pidState(session.pid) !== "alive") return { state: "stale", reason: "pid_dead", ready };
	if (platform === "win32") {
		return ready ? { state: "healthy", reason: "ready", ready: true }
			: { state: "foreign", reason: "identity_unconfirmed", ready: false };
	}
	if (session.pid !== process.pid) {
		let cmdline = "";
		if (process.platform === "darwin") cmdline = runPs(session.pid)?.command ?? "";
		else try {
			cmdline = fs.readFileSync(`/proc/${session.pid}/cmdline`, "utf8");
		} catch {}
		if (!DAEMON_CMDLINE.test(cmdline)) return { state: "foreign", reason: "other_process", ready };
		if (!isDaemonProcess(session.pid, session.procStart)) return { state: "foreign", reason: "identity_unconfirmed", ready };
	} else if (session.procStart !== undefined && session.procStart !== procStartTicks(process.pid)) {
		// our pid, but the start time was written by another process: recycled pid
		return { state: "stale", reason: "pid_recycled", ready };
	}
	// R8: ppid 1 is not the only orphan shape. Under a systemd --user session an
	// orphan is reparented to the user subreaper (pid != 1), so the current ppid
	// is compared with the boot-time ppid recorded in session.json; ppid 1 stays
	// accepted. Without /proc (ppid undefined) the check degrades honestly: no
	// orphan detection, never a crash.
	const ppidNow = ppid(session.pid);
	if (ppidNow === 1 || (ppidNow !== undefined && typeof session.ppid === "number" && ppidNow !== session.ppid)) {
		return { state: "orphaned", reason: "parent_gone", ready };
	}
	return ready ? { state: "healthy", reason: "ready", ready: true } : { state: "stale", reason: "endpoint_refused", ready: false };
}

class Daemon extends EventEmitter {
	/**
	 * @param {object} [options]
	 * @param {string} [options.root]           island root (default ABITO_ISLAND_DIR / ~/.abito-island)
	 * @param {object} [options.env]            environment (default process.env)
	 * @param {(line:string)=>void} [options.log]
	 * @param {object} [options.engineOptions]  extra AgentEngine options (tests: fake command)
	 * @param {object} [options.accountsOptions]
	 * @param {object} [options.serverOptions]  extra IslandServer options (limits)
	 */
	constructor(options = {}) {
		super();
		this.env = options.env ?? process.env;
		this.root = path.resolve(options.root ?? defaultIslandRoot(this.env));
		// Platform seam for tests ONLY: production always runs the real platform.
		this.platform = options.platform ?? process.platform;
		this.log = options.log ?? (() => {});
		this.options = options;
		this.state = "stopped";
		this.changing = Promise.resolve();
		this.connectorsControl = undefined;
	}

	get sessionFile() {
		return sessionPath(this.root);
	}

	async start() {
		if (this.state !== "stopped") throw new Error("daemon already started");
		this.state = "starting";
		try {
			await this.boot();
			this.state = "running";
			return { endpoint: this.endpoint, pid: process.pid };
		} catch (error) {
			await this.teardown();
			this.state = "stopped";
			throw error;
		}
	}

	async boot() {
		// Windows (B5/S6): validate the island root against the canonical
		// protected %LOCALAPPDATA%\Abito root BEFORE ensureIsland, config or ANY
		// directory write — a forbidden root must never get files created in it.
		const violation = windowsIslandRootViolation(this.root, this.env, this.platform);
		if (violation) throw new Error(`refusing island root: ${violation}`);
		ensureIsland(this.root);
		const cfg = config.loadConfig(this.root, { env: this.env }); // fail-closed before anything spawns
		const existing = readSession(this.root);
		// #390 GD029 arbitration: NEVER replace a session whose endpoint answers
		// `ready`; replace only when the endpoint refuses AND the pid is confirmed
		// dead. Every attempt is recorded in the launch ledger.
		let replaced = false;
		if (existing) {
			const verdict = await classifySession(this.root);
			if (verdict.ready) {
				this.recordLaunch({ reason: "endpoint_ready", outcome: "refused", incumbentPid: existing.pid });
				throw new Error("daemon already running");
			}
			if (pidState(existing.pid) !== "dead") {
				const reason = verdict.state === "foreign" ? "foreign_session" : verdict.reason === "pid_recycled" ? "pid_recycled" : "unresponsive_session";
				this.recordLaunch({ reason, outcome: "refused", incumbentPid: existing.pid });
				throw new Error("daemon already running (the session's pid is alive; refusing to replace it)");
			}
			replaced = true; // endpoint refuses AND pid confirmed dead: the only replaceable case
		}
		const mcp = config.writeMcpProjection(this.root, cfg.mcpConfigPath);
		this.wroteMcp = true;
		this.mcpServers = Object.keys(mcp.mcpServers).length;
		this.cfg = cfg;

		const engine = new AgentEngine({
			root: this.root,
			env: this.env,
			command: cfg.command,
			workspacePath: cfg.workspace,
			log: (line) => this.log(line),
			...(this.options.engineOptions ?? {}),
		});
		this.engine = engine;
		this.accounts = new AccountManager({
			accountsRoot: path.join(this.root, "accounts"),
			env: this.env,
			log: (line) => this.log(line),
			inUse: (id) => this.profiles.usesAccount(id),
			...(this.options.accountsOptions ?? {}),
		});
		this.profiles = new ProfileStore({
			islandRoot: this.root,
			agentDir: path.join(this.root, "agent"),
			accounts: () => new Map(this.accounts.listAccounts().map((a) => [a.accountId, a])),
			engine,
		});
		engine.on("status", ({ state }) => {
			if (state === "ready" && this.cfg.thinking && !this.activeProfile() && this.state !== "stopped") {
				engine.request({ type: "set_thinking_level", level: this.cfg.thinking }).catch(() => this.log("could not apply the thinking default"));
			}
		});
		await engine.start();
		if (cfg.profile) await this.profiles.select(cfg.profile).catch(() => this.log("could not activate the configured profile"));

		this.connectorHost = undefined;
		this.connectorHostUnavailable = false;
		this.connectorsControl = undefined;
		if (cfg.connectorHostBin) {
			this.connectorHost = new ConnectorHostSupervisor({
				binPath: cfg.connectorHostBin,
				islandDir: this.root,
				log: (line) => this.log(line),
				...(this.options.connectorHostOptions ?? {}),
			});
			try {
				await this.connectorHost.start();
			} catch {
				this.connectorHostUnavailable = true;
				this.log("connector host unavailable");
			}
		}

		const runtimeDir = ensurePrivateDir(path.join(this.root, "runtime"));
		this.connectors = this.makeConnectors(cfg);
		this.mcpImport = this.makeMcpImport();
		if (cfg.connectorHostBin && this.connectorHost) {
			this.connectorsControl = new ConnectorsControl({
				host: this.connectorHost,
				catalog: async () => {
					if (!this.connectors) throw new Error("connectors catalog unavailable");
					return (await this.connectors.snapshot()).catalog;
				},
				log: (line) => this.log(line),
			});
		}
		this.agents = this.makeAgents(cfg);
		this.agentHooks = this.makeAgentHooks();
		this.token = IslandServer.generateToken();
		// #386: rotation runs only when the user opted in; the summary travels
		// with the user's NEXT prompt, never as a daemon-issued model request.
		this.rotator = cfg.rotation?.enabled === true
			? new SessionRotator({
				engine,
				log: (line) => this.log(line),
				isPaused: () => this.server?.paused === true,
				...(cfg.rotation.thresholdPercent !== undefined ? { thresholdPercent: cfg.rotation.thresholdPercent } : {}),
				...(cfg.rotation.keepTurns !== undefined ? { keepTurns: cfg.rotation.keepTurns } : {}),
			})
			: undefined;
		this.server = new IslandServer({
			runtimeDir,
			token: this.token,
			engine,
			accounts: this.accounts,
			profiles: this.profiles,
			connectors: this.connectors,
			mcpImport: this.mcpImport,
			connectorsControl: this.connectorsControl,
			agents: this.agents,
			agentHooks: this.agentHooks,
			sessions: { snapshot: async () => scanSessions({ scopePid: sessionScope(this.env) }) }, // #360: read-only /proc discovery (L52: was never wired)
			settings: { get: () => ({ hotkey: this.getHotkey() }), setHotkey: (value) => this.persistHotkey(value) },
			paused: cfg.paused === true, // #379: the persisted pause is restored at every boot
			pausedStore: { get: () => this.cfg?.paused === true, set: (value) => this.persistPaused(value) },
			promptDecorator: (message) => this.rotator?.beginPrompt(message) ?? message, // #386 (R6: committed only after the engine accepts the prompt)
			interruptedRecord: () => this.readInterruptedSummary(), // R5: bounded closed summary of the unconsumed record
			onInterruptedAck: () => this.consumeInterruptedRecord(), // R5: consumption happens only after a client ack
			onNewConversation: () => this.rotator?.discardPending(), // #386
			log: (line) => this.log(line),
			...(this.options.serverOptions ?? {}),
		});
		const { endpoint } = await this.server.start();
		this.endpoint = endpoint;
		this.startedAt = Date.now();
		// R8: the boot-time parent pid lets a later launch detect reparenting
		// (an orphan under systemd --user lands on the user subreaper, ppid != 1).
		const session = {
			protocol: PROTOCOL,
			endpoint,
			token: this.token,
			pid: process.pid,
			procStart: procStartTicks(process.pid),
			startedAt: this.startedAt,
			ppid: ppidOf(process.pid),
		};
		if (process.platform === "win32") {
			// Windows (L6): the native helper owns the token file's protected DACL.
			publishSessionWindows(this.root, session);
		} else {
			writePrivateFile(this.sessionFile, `${JSON.stringify(session)}\n`);
		}
		this.wroteSession = true;
		this.recordLaunch({ reason: replaced ? "stale_replaced" : "ok", outcome: "started", ...(replaced ? { incumbentPid: existing.pid } : {}) });
		// R5: a boot never consumes the interrupted-work record; it is exposed
		// once through the ready frame and consumed only after interrupted_ack.
	}

	/**
	 * #390 GD029 — append one launch record `{at,pid,procStart,reason,outcome}`
	 * (plus `incumbentPid` when an incumbent session was refused or replaced) to
	 * `<root>/runtime/launches.jsonl`, created 0600. Evidence, never authority:
	 * the ledger carries no token, refuses to append to an unsafe/foreign file,
	 * and ANY failure is logged and skipped — a broken ledger never blocks a boot.
	 */
	recordLaunch({ reason, outcome, incumbentPid }) {
		try {
			const dir = ensurePrivateDir(path.join(this.root, "runtime"));
			const file = path.join(dir, "launches.jsonl");
			const record = { at: Date.now(), pid: process.pid, procStart: procStartTicks(process.pid), reason, outcome };
			if (incumbentPid !== undefined) record.incumbentPid = incumbentPid;
			const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
			const fd = fs.openSync(file, flags, 0o600);
			try {
				const meta = fs.fstatSync(fd);
				if (!meta.isFile() || (meta.mode & 0o777) !== 0o600 || (uid() !== undefined && meta.uid !== uid())) {
					throw new Error("launches.jsonl is not our private regular file");
				}
				fs.writeSync(fd, `${JSON.stringify(record)}\n`);
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			this.log(`launch record skipped: ${error.message}`);
		}
	}

	/**
	 * #385 OD066 — write the single interrupted-work record
	 * `<root>/runtime/interrupted.json` (0600, atomic, refusing symlinks and
	 * non-regular files, like every private write). Taken BEFORE server.close()
	 * drops the clients and closes the asks, while the state still exists.
	 * Evidence, never authority: exactly one record is kept (the newest stop
	 * wins), it is never deleted — a healthy boot only marks it consumed — and
	 * it never carries a token nor prompt content. ANY failure is logged and
	 * skipped: a broken record never blocks a teardown.
	 */
	recordInterruptedWork() {
		try {
			const snapshot = this.server?.snapshotInterruptions?.();
			if (!snapshot || (snapshot.turnActive !== true && snapshot.asks.length === 0)) return; // nothing was interrupted
			const record = {
				at: Date.now(),
				pid: process.pid,
				procStart: procStartTicks(process.pid),
				turnActive: snapshot.turnActive === true,
				asks: snapshot.asks,
				consumed: false,
			};
			writePrivateFile(path.join(this.root, "runtime", "interrupted.json"), `${JSON.stringify(record)}\n`);
		} catch (error) {
			this.log(`interrupted-work record skipped: ${error.message}`);
		}
	}

	/**
	 * R5 — bounded closed summary of the unconsumed interrupted-work record:
	 * `{at, turnActive, asks}` (counts and time only; never titles, ids,
	 * prompts, args or secrets), or undefined when there is nothing unconsumed
	 * or the file is missing/unsafe. Read-only; never mutates the record.
	 */
	readInterruptedSummary() {
		try {
			const file = path.join(this.root, "runtime", "interrupted.json");
			const stats = fs.lstatSync(file);
			if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
			const record = JSON.parse(fs.readFileSync(file, "utf8"));
			if (record?.consumed !== false) return undefined;
			return {
				at: typeof record.at === "number" ? record.at : 0,
				turnActive: record.turnActive === true,
				asks: Array.isArray(record.asks) ? record.asks.length : 0,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * #385 OD066 — mark the interrupted-work record consumed. Since R5 this
	 * runs ONLY after a client acknowledged the exposed record (interrupted_ack),
	 * never at boot. The record is kept as evidence; it is never deleted without
	 * marking it first. R4 (RDD): the result is observable — true means the
	 * record is consumed or there was nothing left to consume (missing file,
	 * non-regular file, already consumed); false means persistence failed and
	 * the record stays unconsumed so the client can retry.
	 */
	consumeInterruptedRecord() {
		const file = path.join(this.root, "runtime", "interrupted.json");
		let stats;
		try {
			stats = fs.lstatSync(file);
		} catch (error) {
			if (error.code === "ENOENT") return true; // nothing left to consume
			this.log(`interrupted-work record not consumed: ${error.message}`);
			return false;
		}
		if (!stats.isFile() || stats.isSymbolicLink()) return true; // nothing left to consume
		let record;
		try {
			record = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			this.log(`interrupted-work record not consumed: ${error.message}`);
			return false;
		}
		if (record?.consumed !== false) return true; // already consumed
		try {
			writePrivateFile(file, `${JSON.stringify({ ...record, consumed: true })}\n`);
		} catch (error) {
			this.log(`interrupted-work record not consumed: ${error.message}`);
			return false;
		}
		return true;
	}

	/**
	 * Read-only MCP config import preview (#381): scans OTHER desktop clients' known config
	 * locations under the daemon's real HOME (never the island home). No config key, no
	 * execution, nothing written. Without a usable HOME the verb answers "unavailable".
	 */
	makeMcpImport() {
		let home;
		try {
			home = validateHome(typeof this.env.HOME === "string" ? this.env.HOME : "");
		} catch {
			return undefined; // no usable HOME: mcp_import_preview answers "unavailable"
		}
		const homeDir = home;
		return { preview: async () => scanMcpConfigs({ home: homeDir }) };
	}

	/**
	 * Read-only connectors view for connectors_list. The connectors dir is created (0700, refusing
	 * symlinks/foreign owners) at first use, never at boot. Config is read at daemon start.
	 */
	makeConnectors(cfg) {
		if (!cfg.connectorsCommand) return undefined; // no default execution: connectors_list answers "unavailable"
		const paths = islandPaths(this.root);
		const view = new ConnectorsView({
			command: cfg.connectorsCommand,
			dir: cfg.connectorsDir,
			cwd: paths.root,
			home: paths.home,
			env: this.env,
			log: (line) => this.log(line),
		});
		return {
			snapshot: async () => {
				ensurePrivateDir(cfg.connectorsDir);
				return view.snapshot();
			},
		};
	}

	/**
	 * Agent hook manager (agent_connect/agent_disconnect). Always built so agents_list answers (every
	 * agent "unavailable" without `hookInstallerBin`, nothing executes). The installer is run with the
	 * REAL home of this process as HOME (it edits ~/.claude and ~/.codex); the audit goes to <island>/audit.
	 */
	makeAgents(cfg) {
		return new AgentsManager({
			installerBin: cfg.hookInstallerBin ?? this.options.defaultInstallerBin,
			home: process.env.HOME || os.homedir(),
			islandDir: this.root,
			log: (line) => this.log(line),
			...(this.options.agentsOptions ?? {}),
		});
	}

	/**
	 * Agent hooks catalogue (#361): preview/install/remove for Gemini CLI, Copilot CLI, OpenCode and Amp
	 * (native) plus claude-code/codex (through the AgentsManager). Built here but NOTHING runs until an
	 * explicit hooks_install / hooks_remove frame carries the exact plan_hash; preview is read-only.
	 */
	makeAgentHooks() {
		let home;
		try {
			home = validateHome(process.env.HOME || os.homedir());
		} catch {
			return undefined; // no usable HOME: the hooks verbs answer "unavailable"
		}
		return createAgentHooks({ home, agents: this.agents, nodeExe: process.execPath, log: (line) => this.log(line), ...(this.options.agentHooksOptions ?? {}) });
	}

	/** The persisted global hotkey (canonical) or null. */
	getHotkey() {
		return this.cfg?.hotkey ?? null;
	}

	/** Validates + persists the hotkey (no engine restart, no 'settings' event: the caller broadcasts). */
	persistHotkey(value) {
		const result = config.setHotkey(this.root, value);
		this.cfg = { ...(this.cfg ?? {}), hotkey: result.hotkey ?? undefined, hotkeyInvalid: false };
		return result;
	}

	/** Validates + persists the global pause switch (#379; no engine restart: the server owns and broadcasts the state). */
	persistPaused(value) {
		const result = config.setPaused(this.root, value === true);
		this.cfg = { ...(this.cfg ?? {}), paused: result.paused };
		return result;
	}

	/** Public API: persists the hotkey, emits 'settings' and pushes it to connected clients when it changed. */
	setHotkey(value) {
		const result = this.persistHotkey(value);
		if (result.changed) this.announceSettings();
		return result;
	}

	announceSettings() {
		this.emit("settings", { hotkey: this.getHotkey() });
		this.server?.broadcastSettings();
	}

	/** The profile selected through the ProfileStore (survives restarts), or undefined. */
	activeProfile() {
		try {
			return this.profiles?.load().active;
		} catch {
			return undefined;
		}
	}

	/** Synchronous, token-checked removal of session.json (process 'exit' handler; SIGKILL cannot be handled). */
	cleanupSync() {
		if (this.wroteMcp) {
			config.removeMcpProjection(this.root);
			this.wroteMcp = false;
		}
		if (!this.wroteSession) return;
		try {
			const current = readSession(this.root);
			if (current && current.token === this.token && current.pid === process.pid) {
				fs.unlinkSync(this.sessionFile);
				this.wroteSession = false;
			}
		} catch {}
	}

	async teardown() {
		this.rotator?.stop(); // #386: detach before the engine goes down
		if (this.wroteSession) {
			try {
				const current = readSession(this.root);
				if (current && current.token === this.token) fs.unlinkSync(this.sessionFile);
			} catch {}
			this.wroteSession = false;
		}
		// #385 OD066: record the work this stop is about to lose while the
		// server still holds the open asks and the busy turn.
		this.recordInterruptedWork();
		// Cancel setup prompts and detach control listeners before stopping their host.
		await this.connectorsControl?.close().catch(() => {});
		this.connectorsControl = undefined;
		// The connector host removes its MCP source before the engine and daemon projection stop.
		await this.connectorHost?.stop().catch(() => {});
		await this.server?.close().catch(() => {});
		await this.engine?.stop().catch(() => {});
		// After the engine stop, so pi is gone before its MCP capability file is.
		if (this.wroteMcp) {
			config.removeMcpProjection(this.root);
			this.wroteMcp = false;
		}
		this.server = undefined;
		this.token = undefined;
	}

	async stop() {
		if (this.state === "stopped") return;
		this.state = "stopping";
		await this.teardown();
		this.state = "stopped";
	}

	/** Sanitized status; never includes the token. */
	status() {
		const cfg = this.cfg ?? {};
		return {
			state: this.state === "running" ? (this.engine?.status ?? "stopped") : this.state,
			pid: process.pid,
			startedAt: this.startedAt,
			endpoint: this.endpoint,
			workspace: cfg.workspace,
			workspaceSource: cfg.workspaceSource,
			memoryPinConflict: cfg.workspace ? config.detectMemoryPinConflict(cfg.workspace) : false,
			mcpServers: this.mcpServers ?? 0,
			busy: this.server?.busy === true,
			paused: this.server ? this.server.paused === true : this.cfg?.paused === true,
			hotkey: this.getHotkey(),
			hotkeyInvalid: cfg.hotkeyInvalid === true,
			connectorsAvailable: this.connectors !== undefined,
			mcpImportAvailable: this.mcpImport !== undefined,
			connectorHost: this.connectorHost ? (this.connectorHostUnavailable ? "unavailable" : this.connectorHost.status) : "unavailable",
			connectorHostAvailable: this.connectorHost?.status === "ready" && !this.connectorHostUnavailable,
			agentsAvailable: this.agents?.available === true,
		};
	}

	/** Serializes workspace/config changes. */
	serialize(fn) {
		const run = this.changing.then(fn, fn);
		this.changing = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Persists a new workspace and restarts the engine on it. Refused while a
	 * turn runs. The old session pointer is cleared, so the new engine starts a
	 * fresh conversation; the server, socket and token stay up.
	 */
	setWorkspace(workspace) {
		return this.serialize(async () => {
			if (this.state !== "running") throw new Error("daemon is not running");
			if (this.server?.busy) throw new Error("busy: finish or abort the current turn first");
			const result = config.setWorkspace(this.root, workspace, { env: this.env });
			const restarted = await this.restartIfWorkspaceMoved();
			return { ...result, restarted };
		});
	}

	/**
	 * Re-reads config.json (SIGHUP) and restarts the engine only when the
	 * effective cwd, `command` or `mcpConfigPath` changed (MCP is re-projected
	 * first, so a bad source changes nothing). `profile` is read at daemon start
	 * only: change profiles at runtime with the `profile_select` request.
	 * `thinking` takes effect at the next engine ready.
	 */
	applyConfig() {
		return this.serialize(async () => {
			if (this.state !== "running") throw new Error("daemon is not running");
			if (this.server?.busy) throw new Error("busy: finish or abort the current turn first");
			const before = this.getHotkey();
			const restarted = await this.restartIfWorkspaceMoved();
			if (this.getHotkey() !== before) this.announceSettings();
			return { restarted };
		});
	}

	async restartIfWorkspaceMoved() {
		const next = config.loadConfig(this.root, { env: this.env });
		const engine = this.engine;
		const overrides = this.options.engineOptions ?? {};
		const effective = (workspace) => engine.cwdOption ?? workspace ?? engine.island.workspace;
		const cwdMoved = effective(next.workspace) !== effective(engine.workspacePath);
		const commandMoved = overrides.command === undefined && next.command !== engine.command;
		const mcpMoved = next.mcpConfigPath !== this.cfg.mcpConfigPath;
		if (mcpMoved) {
			// Validates and writes before anything stops; throws leave the engine untouched.
			this.wroteMcp = true;
			this.mcpServers = Object.keys(config.writeMcpProjection(this.root, next.mcpConfigPath).mcpServers).length;
		}
		if (!cwdMoved && !commandMoved && !mcpMoved) {
			this.cfg = { ...this.cfg, ...next };
			engine.workspacePath = next.workspace;
			return false;
		}
		await engine.stop();
		if (cwdMoved) config.clearSessionPointer(this.root);
		engine.workspacePath = next.workspace;
		if (commandMoved) engine.command = next.command;
		this.cfg = { ...this.cfg, ...next };
		await engine.start();
		return true;
	}
}

module.exports = {
	DAEMON_CMDLINE,
	Daemon,
	PROTOCOL,
	classifySession,
	findSessionHelper,
	isDaemonProcess,
	pidAlive,
	pidState,
	publishSessionWindows,
	verifySessionWindows,
	probeEndpoint,
	procStartTicks,
	readSession,
	sessionHelperCandidates,
	sessionPath,
};

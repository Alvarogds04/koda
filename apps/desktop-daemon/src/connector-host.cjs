"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const util = require("node:util");
const { assertSecurePath } = require("./isolation.cjs");
const { ConnectorHostClient, ConnectorHostError } = require("./connector-host-client.cjs");

const PROTOCOL = "abito-connector-host/1";
const DEFAULTS = Object.freeze({ backoffMs: [1000, 2000, 4000, 8000, 16000, 30000], stableMs: 30000, startTimeoutMs: 10000, requestTimeoutMs: 10000, stopTimeoutMs: 5000 });
const HANDOFF_KEYS = ["endpoint", "pid", "procStart", "protocol", "startedAt", "token"];
const uid = () => typeof process.getuid === "function" ? process.getuid() : undefined;

function procIdentity(pid) {
	if (process.platform === "darwin") {
		const info = require("./procinfo.cjs").runPs(pid);
		return info && { start: info.start, ppid: info.ppid, state: info.state };
	}
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		const start = fields[19];
		if (!/^\d+$/.test(start ?? "") || !/^\d+$/.test(fields[1] ?? "")) return undefined;
		return { start, ppid: Number(fields[1]), state: fields[0] };
	} catch { return undefined; }
}
function procStartTicks(pid) { return procIdentity(pid)?.start; }
function fail() { throw new Error("connector host unavailable"); }

function assertTrustedDirectoryChain(parent) {
	const currentUid = uid();
	let current = path.parse(parent).root;
	const parts = parent.slice(current.length).split(path.sep).filter(Boolean);
	const directories = [current];
	for (const part of parts) {
		current = path.join(current, part);
		directories.push(current);
	}
	for (let index = 0; index < directories.length; index++) {
		const directory = directories[index];
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && (currentUid === undefined || stat.uid !== currentUid))) fail();
		if ((stat.mode & 0o022) !== 0) {
			const rootStickyAncestor = index < directories.length - 1 && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
			if (!rootStickyAncestor) fail();
		}
	}
}

/** Use-time trust check, repeated immediately before every host spawn. */
function assertTrustedBinary(file) {
	try {
		if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith("/")) fail();
		const currentUid = uid();
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.uid !== 0 && (currentUid === undefined || stat.uid !== currentUid)) || (stat.mode & 0o7000) !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) fail();
		assertTrustedDirectoryChain(path.dirname(file));
		fs.accessSync(file, fs.constants.X_OK);
		return file;
	} catch { fail(); }
}

function privateDir(dir, expectedUid) {
	const st = fs.lstatSync(dir);
	if (!st.isDirectory() || st.isSymbolicLink() || (expectedUid !== undefined && st.uid !== expectedUid) || (st.mode & 0o7777) !== 0o700) fail();
	return st;
}
function validateEndpoint(endpoint, islandDir, expectedUid) {
	if (typeof endpoint !== "string" || !path.isAbsolute(endpoint) || path.normalize(endpoint) !== endpoint || Buffer.byteLength(endpoint) > 107) fail();
	const runRoot = path.join(islandDir, "connector-host-run");
	const runDir = path.dirname(endpoint);
	if (path.dirname(runDir) !== runRoot || !/^p-[A-Za-z0-9]{6}$/.test(path.basename(runDir)) || path.basename(endpoint) !== "s") fail();
	assertSecurePath(endpoint);
	privateDir(runRoot, expectedUid);
	privateDir(runDir, expectedUid);
	const sock = fs.lstatSync(endpoint);
	if (!sock.isSocket() || sock.isSymbolicLink() || (expectedUid !== undefined && sock.uid !== expectedUid) || (sock.mode & 0o7777) !== 0o600) fail();
	return { dev: sock.dev, ino: sock.ino };
}

/** Strict canonical JSON handoff validation; no path or contents leave this function. */
function readHandoff(file, islandDir, child, childStart, expectedUid = uid()) {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || (expectedUid !== undefined && stat.uid !== expectedUid)) fail();
	const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) fail();
	const keys = Object.keys(value);
	if (keys.length !== HANDOFF_KEYS.length || keys.slice().sort().some((key, i) => key !== HANDOFF_KEYS[i])) fail();
	// Rust serializes serde_json maps in byte-sorted key order and appends exactly one LF.
	const canonical = Object.fromEntries(HANDOFF_KEYS.map((key) => [key, value[key]]));
	if (raw !== `${JSON.stringify(canonical)}\n`) fail();
	if (value.protocol !== PROTOCOL || value.pid !== child.pid || !Number.isSafeInteger(value.procStart) || value.procStart < 0 || String(value.procStart) !== childStart || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 || typeof value.token !== "string" || !/^[0-9a-f]{64}$/.test(value.token)) fail();
	const identity = procIdentity(value.pid);
	if (!identity || identity.start !== childStart || identity.ppid !== process.pid || identity.state === "Z" || identity.state === "X") fail();
	const socketIdentity = validateEndpoint(value.endpoint, islandDir, expectedUid);
	return { endpoint: value.endpoint, token: value.token, pid: value.pid, procStart: childStart, startedAt: value.startedAt, socketIdentity };
}

function wait(ms, timer = setTimeout) { return new Promise((resolve) => timer(resolve, ms)); }
function raceTimeout(promise, ms) {
	let timer;
	return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

class ConnectorHostSupervisor extends EventEmitter {
	constructor(options) {
		super();
		this.binPath = options.binPath;
		this.islandDir = path.resolve(options.islandDir);
		this.home = path.join(this.islandDir, "home");
		this.baseEnv = options.env ?? process.env;
		this.now = options.now ?? Date.now;
		this.spawnProcess = options.spawn ?? spawn;
		this.signalPid = options.signal ?? ((pid, signal) => process.kill(pid, signal));
		this.readProcStart = options.procStart ?? procStartTicks;
		this.backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
		this.stableMs = options.stableMs ?? DEFAULTS.stableMs;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULTS.startTimeoutMs;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
		this.log = options.log ?? (() => {});
		this.status = "stopped";
		this.child = undefined;
		this.client = undefined;
		this.childProcStart = undefined;
		this.exitPromise = undefined;
		this.exitResolve = undefined;
		this.exitInfo = undefined;
		this.handoff = undefined;
		this.attempts = 0;
		this.spawnedAt = 0;
		this.restartTimer = undefined;
		this.stopping = false;
		this.initialStartPending = false;
		this.lossHandled = false;
		this.generation = 0;
		this.outputCapBytes = options.outputCapBytes ?? 256 * 1024;
		this.stdoutBytes = 0;
		this.stderrBytes = 0;
	}

	setStatus(status) {
		if (this.status === status) return;
		this.status = status;
		this.emit("status", status);
	}

	childEnvironment() {
		const env = { PATH: "/usr/bin:/bin", HOME: this.home };
		if (typeof this.baseEnv.LANG === "string" && this.baseEnv.LANG !== "" && !this.baseEnv.LANG.includes("\0")) env.LANG = this.baseEnv.LANG;
		return env;
	}

	async start() {
		if (this.status !== "stopped" || this.child) throw new Error("connector host unavailable");
		this.stopping = false;
		this.initialStartPending = true;
		this.lossHandled = false;
		this.setStatus("starting");
		try {
			await this.spawnAndHandshake();
			this.initialStartPending = false;
			this.spawnedAt = this.now();
			this.setStatus("ready");
		} catch {
			this.initialStartPending = false;
			await this.abortChild();
			this.handoff = undefined;
			this.childProcStart = undefined;
			this.setStatus("stopped");
			throw new Error("connector host unavailable");
		}
	}

	spawnAndHandshake() {
		assertTrustedBinary(this.binPath);
		const islandStat = fs.lstatSync(this.islandDir);
		if (!islandStat.isDirectory() || islandStat.isSymbolicLink() || (uid() !== undefined && islandStat.uid !== uid())) fail();
		assertSecurePath(this.islandDir);
		privateDir(this.islandDir, uid());
		const args = ["--island", this.islandDir, "--parent", String(process.pid)];
		const options = { stdio: ["ignore", "pipe", "pipe"], detached: false, shell: false, cwd: this.islandDir, env: this.childEnvironment() };
		const handoffFile = path.join(this.islandDir, "connector-host.json");
		let priorHandoff;
		try { priorHandoff = fs.lstatSync(handoffFile); } catch {}
		let child;
		assertTrustedBinary(this.binPath);
		try { child = this.spawnProcess(this.binPath, args, options); } catch { fail(); }
		if (!child || !Number.isInteger(child.pid) || child.pid <= 1) fail();
		this.child = child;
		this.childProcStart = undefined;
		this.handoff = undefined;
		this.generation++;
		const generation = this.generation;
		this.exitInfo = undefined;
		this.exitPromise = new Promise((resolve) => { this.exitResolve = resolve; });
		this.stdoutBytes = 0;
		this.stderrBytes = 0;
		child.stdout?.on("data", (chunk) => { this.stdoutBytes = Math.min(this.outputCapBytes, this.stdoutBytes + chunk.length); }); // drain and count only; never store or surface
		child.stderr?.on("data", (chunk) => { this.stderrBytes = Math.min(this.outputCapBytes, this.stderrBytes + chunk.length); });
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});
		child.on("error", () => {});
		child.once("spawn", () => { this.childProcStart = this.readProcStart(child.pid); });
		child.once("close", (code, signal) => this.handleExit(child, generation, code, signal));
		return this.awaitHandoff(child, generation, priorHandoff).then(async (handoff) => {
			if (this.child !== child || this.exitInfo) fail();
			this.handoff = { pid: handoff.pid, procStart: handoff.procStart, startedAt: handoff.startedAt };
			const client = new ConnectorHostClient({ endpoint: handoff.endpoint, token: handoff.token, requestTimeoutMs: this.requestTimeoutMs });
			this.client = client;
			client.on("connectors", (frame) => this.emit("connectors", frame));
			client.on("pending", (items) => this.emit("pending", items));
			client.once("close", () => this.handleConnectionLoss(child, generation));
			await client.connectSocket();
			const socketStat = fs.lstatSync(handoff.endpoint);
			if (!socketStat.isSocket() || socketStat.dev !== handoff.socketIdentity.dev || socketStat.ino !== handoff.socketIdentity.ino || this.child !== child || this.exitInfo || this.stopping) fail();
		});
	}

	async awaitHandoff(child, generation, priorHandoff) {
		const deadline = this.now() + this.startTimeoutMs;
		const file = path.join(this.islandDir, "connector-host.json");
		while (this.now() <= deadline) {
			if (this.child !== child || this.exitInfo) fail();
			const identity = procIdentity(child.pid);
			if (identity && !this.childProcStart) this.childProcStart = identity.start;
			if (this.childProcStart && identity?.start !== this.childProcStart) fail();
			try {
				const current = fs.lstatSync(file);
				if (priorHandoff && current.dev === priorHandoff.dev && current.ino === priorHandoff.ino) {
					// A hard-exit handoff is replaced atomically by the next host; do not reject its stale identity.
				} else {
					return readHandoff(file, this.islandDir, child, this.childProcStart, uid());
				}
			} catch (error) {
				if (error?.code !== "ENOENT") fail();
			}
			await wait(Math.min(50, Math.max(1, deadline - this.now())));
			if (generation !== this.generation) fail();
		}
		fail();
	}

	handleExit(child, generation, code, signal) {
		const info = { code: Number.isInteger(code) ? code : null, signal: typeof signal === "string" ? signal : null };
		this.exitInfo = info;
		this.exitResolve?.(info);
		this.emit("exit", info);
		if (this.child !== child || generation !== this.generation) return;
		this.child = undefined;
		if (this.client) { this.client.close(); this.client = undefined; }
		if (this.initialStartPending || this.stopping) return;
		if (info.code === 1 || info.code === 2) {
			this.setStatus("stopped");
			return;
		}
		this.handleConnectionLoss(child, generation);
	}

	handleConnectionLoss(child, generation) {
		if (this.lossHandled || this.stopping || this.initialStartPending || generation !== this.generation) return;
		this.lossHandled = true;
		if (this.child !== child && this.child !== undefined) return;
		if (this.spawnedAt && this.now() - this.spawnedAt >= this.stableMs) this.attempts = 0;
		this.setStatus("restarting");
		const delay = this.backoffMs[Math.min(this.attempts, this.backoffMs.length - 1)] ?? this.backoffMs[this.backoffMs.length - 1] ?? 1000;
		this.attempts++;
		this.restartTimer = setTimeout(async () => {
			this.restartTimer = undefined;
			if (this.stopping) return;
			const previous = this.child;
			if (previous) {
				await this.safeSignal(previous.pid, "SIGTERM");
				if (!(await this.waitForExit(500))) {
					await this.safeSignal(previous.pid, "SIGKILL");
					await this.waitForExit(500);
				}
			}
			if (this.stopping) return;
			if (this.child) { this.setStatus("stopped"); return; }
			this.lossHandled = false;
			this.exitInfo = undefined;
			this.initialStartPending = true;
			this.setStatus("starting");
			try {
				await this.spawnAndHandshake();
				this.initialStartPending = false;
				this.spawnedAt = this.now();
				this.setStatus("ready");
			} catch {
				this.initialStartPending = false;
				await this.abortChild();
				this.handoff = undefined;
				this.childProcStart = undefined;
				if (this.exitInfo?.code === 1 || this.exitInfo?.code === 2 || (!this.exitInfo && !this.child) || this.child) {
					this.setStatus("stopped");
					return;
				}
				if (!this.stopping) {
					this.lossHandled = false;
					this.handleConnectionLoss(this.child, this.generation);
				}
			}
		}, delay);
		this.restartTimer.unref?.();
	}

	async safeSignal(pid, signal) {
		const expected = this.childProcStart;
		if (!Number.isInteger(pid) || pid <= 1 || !expected || this.readProcStart(pid) !== expected) return false;
		try { this.signalPid(pid, signal); return true; } catch { return false; }
	}

	async waitForExit(ms) {
		if (!this.child) return true;
		const promise = this.exitPromise;
		const result = await raceTimeout(promise, ms);
		return result !== false;
	}

	async abortChild() {
		const child = this.child;
		if (!child) { this.client?.close(); this.client = undefined; return; }
		this.client?.close();
		this.client = undefined;
		await this.safeSignal(child.pid, "SIGKILL");
		await this.waitForExit(500);
	}

	async stop() {
		this.stopping = true;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		const child = this.child;
		const client = this.client;
		if (!child) {
			client?.close();
			this.client = undefined;
			this.handoff = undefined;
			this.childProcStart = undefined;
			this.setStatus("stopped");
			return;
		}
		if (client?.ready) {
			try { await raceTimeout(client.shutdown(), 2000); } catch {}
		}
		let exited = await this.waitForExit(this.stopTimeoutMs);
		if (!exited) {
			await this.safeSignal(child.pid, "SIGTERM");
			exited = await this.waitForExit(1000);
		}
		if (!exited) {
			await this.safeSignal(child.pid, "SIGKILL");
			exited = await this.waitForExit(1000);
		}
		client?.close();
		this.client = undefined;
		if (!exited || fs.existsSync(path.join(this.islandDir, "connector-host.json"))) {
			this.log("connector host exited uncleanly; files left for recovery");
		}
		this.handoff = undefined;
		this.childProcStart = undefined;
		this.setStatus("stopped");
	}

	toJSON() { return { state: this.status, pid: this.child?.pid ?? null, restarts: this.attempts }; }
	[util.inspect.custom]() { return this.toJSON(); }
	statusSnapshot() { return this.status; }
	unavailable() { return Promise.reject(new ConnectorHostError("unavailable")); }
	connectors() { return this.client ? this.client.connectors() : this.unavailable(); }
	pending() { return this.client ? this.client.pending() : this.unavailable(); }
	subscribe(enabled) { return this.client ? this.client.subscribe(enabled) : this.unavailable(); }
	approve(proposalId, digest) { return this.client ? this.client.approve(proposalId, digest) : this.unavailable(); }
	deny(proposalId) { return this.client ? this.client.deny(proposalId) : this.unavailable(); }
	connect(id, revision, values) { return this.client ? this.client.connect(id, revision, values) : this.unavailable(); }
	disconnect(id, revision) { return this.client ? this.client.disconnect(id, revision) : this.unavailable(); }
	setEnabled(id, enabled, revision) { return this.client ? this.client.setEnabled(id, enabled, revision) : this.unavailable(); }
	setMode(id, mode, revision) { return this.client ? this.client.setMode(id, mode, revision) : this.unavailable(); }
}

module.exports = { ConnectorHostSupervisor, assertTrustedBinary, procIdentity, procStartTicks, readHandoff, validateEndpoint };

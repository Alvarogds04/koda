"use strict";

/**
 * Abito island engine runtime (U1).
 *
 * Supervises the island agent (the installed `pi` behind the configured
 * executable) in `--mode rpc` as a child process inside the private island
 * (see isolation.cjs), speaks strict JSONL framing, correlates commands with
 * responses, forwards session events, times requests out, rejects pending
 * work when the child exits, respawns after a crash with exponential bounded
 * backoff, and stops without restarting on demand.
 *
 * The engine is an EventEmitter so the transport (U3) and profile lane (U2)
 * can subscribe: "status" ({state}), "event" (agent records), "exit"
 * ({code, signal}) and log lines through the `log` option.
 *
 * Framing, correlation and supervision adapted from the Gentle Dot daemon
 * (MIT, Copyright (c) 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.
 */

const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { spawn } = require("node:child_process");
const { lstatSync, readFileSync } = require("node:fs");
const path = require("node:path");

const { MEMORY_PROJECT, defaultIslandRoot, ensureIsland, isolatedEnv, writePrivateFile } = require("./isolation.cjs");

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_STABLE_MS = 30_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 30_000;
// Abito technical policy, not upstream AG-UI/TanStack constants.
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURN_ITERATIONS = 32;
const DEFAULT_ABORT_GRACE_MS = 2_000;

/** The npm global package that provides Pi on Windows (T2/S4). */
const PI_PACKAGE_SEGMENTS = ["node_modules", "@earendil-works", "pi-coding-agent"];

/**
 * Windows (T2): Pi's npm install is a `.cmd` shim backed by JS. A shim is NEVER
 * executed (no cmd.exe, ever); the engine instead spawns Node with the package's
 * own CLI JS, resolved from the installed package's `package.json` `bin` map in
 * the bounded npm global prefixes (`%AppData%\npm`, then this Node's directory).
 * The entry must be relative, stay inside the package and be a real file —
 * anything else is refused (`undefined`, fail closed).
 */
function windowsPackageCliJs(binName, deps = {}) {
	const env = deps.env ?? process.env;
	const execPath = deps.execPath ?? process.execPath;
	const readFile = deps.readFileSync ?? readFileSync;
	const stat = deps.statSync ?? lstatSync;
	const prefixes = [];
	if (typeof env.AppData === "string" && path.isAbsolute(env.AppData)) prefixes.push(path.join(env.AppData, "npm"));
	if (typeof execPath === "string" && path.isAbsolute(execPath)) {
		const nodeDir = path.dirname(execPath);
		if (!prefixes.includes(nodeDir)) prefixes.push(nodeDir);
	}
	for (const prefix of prefixes) {
		const packageDir = path.join(prefix, ...PI_PACKAGE_SEGMENTS);
		let bin;
		try {
			const manifest = JSON.parse(readFile(path.join(packageDir, "package.json"), "utf8"));
			bin = manifest?.bin?.[binName];
		} catch {
			continue;
		}
		if (typeof bin !== "string" || bin.length === 0 || path.isAbsolute(bin)) continue;
		const resolved = path.resolve(packageDir, bin);
		const relative = path.relative(packageDir, resolved);
		if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		try {
			const stats = stat(resolved);
			if (stats.isFile() && !stats.isSymbolicLink()) return resolved;
		} catch {}
	}
	return undefined;
}

function positiveBudget(value, name, max = 2_147_483_647) {
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
	return value;
}
/** Cap for one unframed child record; anything larger is discarded, never buffered. */
const DEFAULT_MAX_RECORD_BYTES = 1_048_576;

/**
 * Strict JSONL framing for the RPC protocol: records are split on LF bytes
 * only. Node's `readline` is deliberately avoided because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings.
 */
class JsonlDecoder {
	constructor(onRecord, onMalformed = () => {}, onOversized = () => {}, maxBytes = DEFAULT_MAX_RECORD_BYTES) {
		/** Buffered bytes as a list of chunks; never concatenated beyond one line (≤ cap). */
		this.chunks = [];
		this.buffered = 0;
		/** While true, everything up to the next LF belongs to an oversized line and is dropped. */
		this.discarding = false;
		this.onRecord = onRecord;
		this.onMalformed = onMalformed;
		this.onOversized = onOversized;
		this.maxBytes = maxBytes;
	}

	push(chunk) {
		if (this.discarding) {
			// Remainder of an oversized fragmented line: consume up to its LF,
			// never treating the tail as a new record.
			const lf = chunk.indexOf(0x0a);
			if (lf === -1) return;
			this.discarding = false;
			chunk = chunk.subarray(lf + 1);
			if (chunk.length === 0) return;
		}
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		this.drain();
	}

	drain() {
		for (;;) {
			const lfOffset = this.indexOfLf();
			if (lfOffset === -1) {
				// No complete line buffered: reject on length BEFORE any framing
				// attempt if the unframed bytes already exceed the cap.
				if (this.buffered > this.maxBytes) {
					this.reset();
					this.discarding = true;
					this.onOversized();
				}
				return;
			}
			// A complete line is buffered: check its byte length BEFORE
			// toString/JSON.parse, then keep whatever follows intact.
			if (lfOffset > this.maxBytes) {
				this.consume(lfOffset + 1);
				this.onOversized();
				continue;
			}
			let end = lfOffset;
			if (end > 0 && this.byteAt(end - 1) === 0x0d) end -= 1;
			const line = this.takeBytes(end);
			this.consume(lfOffset + 1);
			if (line.trim() !== "") this.emit(line);
		}
	}

	indexOfLf() {
		let offset = 0;
		for (const chunk of this.chunks) {
			const index = chunk.indexOf(0x0a);
			if (index !== -1) return offset + index;
			offset += chunk.length;
		}
		return -1;
	}

	byteAt(index) {
		for (const chunk of this.chunks) {
			if (index < chunk.length) return chunk[index];
			index -= chunk.length;
		}
		return undefined;
	}

	/** Drops the first `n` buffered bytes without decoding them. */
	consume(n) {
		let taken = 0;
		while (n > 0 && this.chunks.length > 0) {
			const first = this.chunks[0];
			if (first.length <= n) {
				taken += first.length;
				n -= first.length;
				this.chunks.shift();
			} else {
				this.chunks[0] = first.subarray(n);
				taken += n;
				n = 0;
			}
		}
		this.buffered -= taken;
	}

	/** The first `n` buffered bytes as text (≤ cap, so any join is bounded). */
	takeBytes(n) {
		if (n === 0) return "";
		const first = this.chunks[0];
		if (first.length >= n) return first.toString("utf8", 0, n);
		const parts = [];
		let left = n;
		for (const chunk of this.chunks) {
			if (left <= 0) break;
			const use = Math.min(left, chunk.length);
			parts.push(use === chunk.length ? chunk : chunk.subarray(0, use));
			left -= use;
		}
		return Buffer.concat(parts).toString("utf8");
	}

	reset() {
		this.chunks = [];
		this.buffered = 0;
	}

	emit(line) {
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			this.onMalformed(line);
			return;
		}
		this.onRecord(record);
	}
}

function encodeRecord(record) {
	return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

/**
 * The island agent engine. Start with `start()`, send commands with
 * `request()` (correlated, timeout-bounded) or `send()` (no response
 * expected), stop with `stop()`.
 */
class AgentEngine extends EventEmitter {
	constructor(options = {}) {
		super();
		/** Executable to run; the default `pi` assumes it is on PATH (configurable, not a direct model call). */
		this.command = options.command ?? "pi";
		this.commandArgs = options.commandArgs ?? [];
		this.extraArgs = options.extraArgs ?? [];
		/** Working directory override; defaults to the owned island workspace. */
		this.cwdOption = options.cwd;
		/**
		 * Arbitrary working folder the user prefers (U4 refines validation and
		 * restart semantics). When set, nothing is ever written there; the
		 * memory-project pin travels via `ABITO_MEMORY_PROJECT` and the
		 * identity prompt instead. See README.md for enforcement limits.
		 */
		this.workspacePath = options.workspacePath;
		this.root = options.root ?? defaultIslandRoot(options.env ?? process.env);
		this.baseEnv = options.env ?? process.env;
		this.envOverrides = options.envOverrides ?? {};
		this.identityPath = options.identityPath ?? path.join(__dirname, "..", "identity.md");
		this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.switchTimeoutMs = options.switchTimeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
		this.turnTimeoutMs = positiveBudget(options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, "turnTimeoutMs");
		this.maxTurnIterations = positiveBudget(options.maxTurnIterations ?? DEFAULT_MAX_TURN_ITERATIONS, "maxTurnIterations");
		this.abortGraceMs = positiveBudget(options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "abortGraceMs");
		this.turn = undefined;
		this.recycling = false;
		this.sessionFile = undefined;
		this.sessionChange = undefined;
		this.recoverySessionFile = undefined;
		this.sessionEpoch = 0;
		this.turnCounter = 0;
		this.log = options.log ?? (() => {});
		this.status = "stopped";
		this.child = undefined;
		this.island = undefined;
		this.identityFile = undefined;
		this.pending = new Map();
		this.closeWaiters = [];
		this.nextId = 0;
		this.attempts = 0;
		this.spawnedAt = 0;
		this.stopping = false;
		this.restarting = false;
		this.restartTimer = undefined;
		this.initialization = undefined;
		this.initialStartPending = false;
	}

	get pid() {
		return this.child?.pid;
	}

	/** Ensures the private island, spawns the agent and waits for its first `get_state`. */
	async start() {
		if (this.status !== "stopped") throw new Error(`cannot start from status "${this.status}"`);
		this.stopping = false;
		// An initial spawn that never becomes ready surfaces to the caller; only
		// a child that reached ready is supervised with crash restarts.
		this.initialStartPending = true;
		this.island = ensureIsland(this.root);
		this.setStatus("starting");
		try {
			await this.spawnAndInitialize();
		} catch (error) {
			this.initialStartPending = false;
			this.setStatus("stopped");
			throw error;
		}
	}

	/** Busy includes cancellation/draining until the replacement child has reached ready. */
	get busy() {
		return this.turn !== undefined || this.sessionChange !== undefined || this.recycling;
	}

	/** RPC ACKs remain separate from a prompt's full-turn lifecycle. */
	async request(command, timeoutMs = this.requestTimeoutMs) {
		if (this.status !== "ready") throw new Error("engine is not ready");
		if (command.type === "abort" && this.turn) return this.cancelTurn(this.turn, "cancelled", timeoutMs);
		if (["prompt", "new_session", "switch_session"].includes(command.type) && this.busy) throw new Error("engine is busy");
		if (command.type === "new_session" || command.type === "switch_session") return this.changeSession(command, timeoutMs);
		const child = this.child;
		if (command.type === "prompt" && !this.sessionFile) {
			const state = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs);
			if (child !== this.child || this.status !== "ready" || this.busy) throw new Error("engine is busy or not ready");
			this.sessionFile = state?.data?.sessionFile;
		}
		const turn = command.type === "prompt" ? this.beginTurn(child) : undefined;
		try {
			return await this.rawRequest(command, timeoutMs);
		} catch (error) {
			// Timeout/ACK loss is not proof that Pi did not apply the prompt. Cut off,
			// never replay, and do not let an old rejection cancel a newer generation.
			if (turn && this.turn === turn && !turn.cancelled) this.cancelTurn(turn, "failed").catch(() => {});
			throw error;
		}
	}

	async changeSession(command, timeoutMs) {
		const change = { child: this.child, sessionFile: this.sessionFile };
		this.sessionChange = change; // Acquire before the first write/await.
		this.emit("status", { state: this.status }); // Canonical daemon/server busy guard.
		const checkGeneration = () => {
			if (this.sessionChange !== change || this.child !== change.child || this.stopping) {
				throw new Error("agent generation changed during session switch");
			}
		};
		try {
			const response = await this.rawRequest(command, timeoutMs);
			checkGeneration();
			// A reset ACK alone does not prove which session Pi now owns.
			const state = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs);
			checkGeneration();
			const sessionFile = state?.data?.sessionFile;
			if (!this.isOwnedSessionFile(sessionFile, true)) throw new Error("agent session is unavailable");
			if (command.type === "switch_session" && path.resolve(sessionFile) !== path.resolve(command.sessionPath)) {
				throw new Error("agent session switch was not confirmed");
			}
			this.sessionFile = sessionFile;
			this.sessionEpoch += 1;
			this.persistSession(sessionFile);
			this.sessionChange = undefined;
			this.emit("status", { state: this.status });
			return response;
		} catch (error) {
			if (this.sessionChange === change && this.child === change.child && !this.stopping) {
				// Applied-but-unacknowledged resets are ambiguous: cut off, reopen
				// the last verified session, and NEVER retry the reset automatically.
				this.recycling = true;
				this.recoverySessionFile = change.sessionFile;
				this.sessionFile = undefined;
				this.setStatus("restarting");
				change.child.kill("SIGKILL");
			}
			throw error;
		}
	}

	beginTurn(child) {
		if (!child || !this.isOwnedSessionFile(this.sessionFile, true)) throw new Error("agent session is unavailable");
		const turn = { child, sessionFile: this.sessionFile, epoch: this.sessionEpoch,
			id: ++this.turnCounter, startedAt: performance.now(), iterations: 0, cancelled: false };
		this.turn = turn;
		this.persistSession(turn.sessionFile);
		const deadline = () => {
			if (this.turn !== turn || turn.cancelled) return;
			const remaining = this.turnTimeoutMs - (performance.now() - turn.startedAt);
			if (remaining > 0) turn.timer = setTimeout(deadline, remaining);
			else this.cancelTurn(turn, "time_limit").catch(() => {});
		};
		turn.timer = setTimeout(deadline, this.turnTimeoutMs);
		return turn;
	}

	clearTurn() {
		clearTimeout(this.turn?.timer);
		clearTimeout(this.turn?.graceTimer);
		this.turn = undefined;
	}

	cancelTurn(turn, reason, timeoutMs = this.requestTimeoutMs) {
		if (turn.cancelled) return turn.abort;
		if (this.turn !== turn || this.child !== turn.child || this.stopping) return Promise.resolve();
		turn.cancelled = true;
		this.recycling = true;
		this.recoverySessionFile = turn.sessionFile;
		clearTimeout(turn.timer);
		// Admission closes synchronously, before any asynchronous abort ACK.
		this.setStatus("restarting");
		this.emit("turn_cancelled", { reason });
		turn.graceTimer = setTimeout(() => this.recycleTurn(turn), this.abortGraceMs);
		turn.abort = this.rawRequest({ type: "abort" }, timeoutMs);
		turn.abort.catch(() => {});
		return turn.abort;
	}

	/**
	 * #378 live interruption: interrupts the active turn for a daemon-level
	 * reason (the global pause turned on, or the user's access was revoked).
	 * Same path as an explicit abort: admission closes, open asks resolve, the
	 * child is recycled and the session reopens; no prompt is ever replayed.
	 * Returns false (and sends nothing) when no turn is active.
	 */
	interruptTurn(reason) {
		if (!this.turn || this.turn.cancelled) return false;
		this.cancelTurn(this.turn, reason).catch(() => {});
		return true;
	}

	recycleTurn(turn) {
		if (this.turn !== turn || this.child !== turn.child || this.stopping) return;
		clearTimeout(turn.graceTimer);
		// Recycle even after settlement: untagged Pi events cannot safely cross a
		// cancelled turn boundary. Existing close supervision reopens the session.
		turn.child.kill("SIGKILL");
	}

	/** Writes a record that has no correlated response (control records, extension UI answers). */
	send(record) {
		const stdin = this.child?.stdin;
		if (this.status !== "ready" || !stdin?.writable) throw new Error("engine is not ready");
		stdin.write(encodeRecord(record));
	}

	/** Stops the agent, disables crash restarts, and terminates it gracefully then forcibly. */
	async stop() {
		this.stopping = true;
		this.clearTurn();
		this.sessionChange = undefined;
		this.recoverySessionFile = undefined;
		this.recycling = false;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		const initializing = this.initialization?.promise;
		const child = this.child;
		if (!child) {
			if (initializing) await initializing.catch(() => {});
			this.setStatus("stopped");
			return;
		}
		const closed = new Promise((resolve) => this.closeWaiters.push(resolve));
		child.stdin?.end();
		const term = setTimeout(() => child.kill("SIGTERM"), this.stopTimeoutMs);
		const kill = setTimeout(() => child.kill("SIGKILL"), this.stopTimeoutMs + 2000);
		await closed;
		clearTimeout(term);
		clearTimeout(kill);
		if (initializing) await initializing.catch(() => {});
	}

	/** Runs before every spawn (first start, restart): regenerates private files in the island. */
	prepareSpawn() {
		if (this.identityPath) {
			this.identityFile = path.join(this.island.root, "identity.md");
			// Fail-closed private write: refuses symlinked/permissive/foreign targets,
			// lands via O_EXCL|O_NOFOLLOW temp rename at 0600.
			writePrivateFile(this.identityFile, readFileSync(this.identityPath));
		} else {
			this.identityFile = undefined;
		}
	}

	/** The persisted session file of the open conversation, if any. */
	readPersistedSession() {
		try {
			const saved = JSON.parse(readFileSync(path.join(this.island.root, "state.json"), "utf8"));
			return typeof saved.sessionFile === "string" ? saved.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * A session path is honoured only inside the private sessions dir, regular, owned, no symlink.
	 * `allowMissing` accepts a not-yet-written file directly in that dir: real Pi reports its
	 * session path at startup/reset but writes the file only after the first message.
	 */
	isOwnedSessionFile(sessionFile, allowMissing = false) {
		if (typeof sessionFile !== "string") return false;
		const resolved = path.resolve(sessionFile);
		if (!resolved.startsWith(`${this.island.sessions}${path.sep}`)) return false;
		let stats;
		try {
			stats = lstatSync(resolved);
		} catch (error) {
			return allowMissing && error?.code === "ENOENT" && path.dirname(resolved) === path.resolve(this.island.sessions);
		}
		if (stats.isSymbolicLink() || !stats.isFile()) return false;
		return typeof process.getuid !== "function" || stats.uid === process.getuid();
	}

	persistSession(sessionFile) {
		if (typeof sessionFile !== "string" || sessionFile === "") return;
		try {
			writePrivateFile(path.join(this.island.root, "state.json"), `${JSON.stringify({ sessionFile })}\n`);
		} catch (error) {
			this.log(`could not persist the session file: ${error.message}`);
		}
	}

	spawnAndInitialize() {
		if (this.initialization || this.child) return Promise.reject(new Error("agent initialization is already owned"));
		const child = this.spawnChild();
		const initialization = { child };
		this.initialization = initialization;
		const run = async () => {
			const state = await this.rawRequest({ type: "get_state" }, this.startTimeoutMs);
			if (this.child !== child) throw new Error("agent exited during startup");
			if (this.stopping) {
				child.kill("SIGKILL");
				return;
			}
			// Session continuity: reopen the conversation the previous child held.
			const expected = this.recoverySessionFile;
			const saved = expected ?? this.readPersistedSession();
			if (expected && !this.isOwnedSessionFile(expected)) throw new Error("agent recovery session is unavailable");
			const current = state?.data?.sessionFile;
			if (saved && saved !== current && this.isOwnedSessionFile(saved)) {
				await this.rawRequest({ type: "switch_session", sessionPath: saved }, this.switchTimeoutMs).catch(
					(error) => {
						if (expected) throw error;
						this.log(`could not reopen the previous session: ${error.message}`);
					},
				);
			}
			const after = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs).catch((error) => {
				if (expected) throw error;
				return undefined;
			});
			if (this.child !== child) throw new Error("agent exited during startup");
			if (this.stopping) {
				child.kill("SIGKILL");
				return;
			}
			this.sessionFile = after?.data?.sessionFile ?? current;
			if (!this.isOwnedSessionFile(this.sessionFile, true)) throw new Error("agent session is unavailable");
			if (expected && this.sessionFile !== expected) throw new Error("agent recovery session was not confirmed");
			this.sessionEpoch += 1;
			this.persistSession(this.sessionFile);
			this.initialStartPending = false;
			this.spawnedAt = Date.now();
			this.recycling = false;
			this.recoverySessionFile = undefined;
			this.setStatus("ready");
		};
		initialization.promise = run().catch((error) => {
			if (this.child === child) child.kill("SIGKILL");
			throw error;
		}).finally(() => {
			if (this.initialization === initialization) this.initialization = undefined;
		});
		return initialization.promise;
	}

	/**
	 * The argv prefix that starts the engine: the command itself — except on
	 * Windows with a bare command name, where the default `pi` resolves to Node
	 * + the npm package's CLI JS (a `.cmd` shim is never executed, and spawn
	 * without a shell cannot run one). Fails closed when it cannot resolve.
	 */
	spawnCommandPrefix() {
		if (process.platform !== "win32" || path.isAbsolute(this.command)) return [this.command];
		const cli = windowsPackageCliJs(this.command);
		if (!cli) {
			throw new Error(`the "${this.command}" command is not available on Windows; install it with npm install -g @earendil-works/pi-coding-agent`);
		}
		return [process.execPath, cli];
	}

	spawnChild() {
		if (this.child) throw new Error("agent child is already owned");
		const cwd = this.cwdOption ?? this.workspacePath ?? this.island.workspace;
		// Regenerate private files first so the identity argument can point at them.
		this.prepareSpawn();
		const args = [
			...this.commandArgs,
			"--mode",
			"rpc",
			"--session-dir",
			this.island.sessions,
			...(this.identityFile ? ["--append-system-prompt", this.identityFile] : []),
			...this.extraArgs,
		];
		const env = {
			...isolatedEnv(this.baseEnv, this.island, { ABITO_MEMORY_PROJECT: MEMORY_PROJECT, ...this.envOverrides }),
		};
		const prefix = this.spawnCommandPrefix();
		const child = spawn(prefix[0], [...prefix.slice(1), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		const decoder = new JsonlDecoder(
			(record) => { if (this.child === child) this.handleRecord(record); },
			() => { if (this.child === child) this.log("agent wrote a malformed record (discarded)"); },
			() => { if (this.child === child) this.log(`agent wrote an oversized record (discarded, over ${this.maxRecordBytes} bytes)`); },
			this.maxRecordBytes,
		);
		child.stdout?.on("data", (chunk) => decoder.push(chunk));
		child.stderr?.on("data", (chunk) => { if (this.child === child) this.log(chunk.toString("utf8").trimEnd()); });
		child.stdin?.on("error", () => {});
		child.on("error", (error) => { if (this.child === child) this.log(`agent process error: ${error.message}`); });
		child.on("close", (code, signal) => this.handleClose(child, code, signal));
		return child;
	}

	rawRequest(command, timeoutMs) {
		const stdin = this.child?.stdin;
		if (!stdin?.writable) return Promise.reject(new Error("engine is not ready"));
		const id = `d${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`agent did not answer ${command.type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			stdin.write(encodeRecord({ ...command, id }));
		});
	}

	handleRecord(record) {
		if (record === null || typeof record !== "object") {
			this.log("agent wrote a non-object record (discarded)");
			return;
		}
		if (record.type === "response") {
			const pending = record.id === undefined ? undefined : this.pending.get(record.id);
			if (!pending) return;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) pending.resolve(record);
			else pending.reject(new Error(record.error ?? `${record.command} failed`));
			return;
		}
		if (this.sessionChange || (this.recycling && !this.turn)) return;
		const turn = this.turn;
		if (turn?.cancelled) {
			if (record.type === "agent_settled") this.recycleTurn(turn);
			return; // No output, asks, or late busy state after cancellation.
		}
		if (turn && record.type === "turn_start" && ++turn.iterations >= this.maxTurnIterations) {
			this.cancelTurn(turn, "iteration_limit").catch(() => {});
			return;
		}
		if (record.type === "agent_settled") this.clearTurn();
		this.emit("event", record);
	}

	handleClose(child, code, signal) {
		if (child !== this.child) return;
		if (this.sessionChange && !this.stopping) {
			this.recycling = true;
			this.recoverySessionFile = this.sessionChange.sessionFile;
		}
		this.sessionChange = undefined;
		this.clearTurn();
		this.sessionFile = undefined;
		this.child = undefined;
		const reason = new Error(`agent exited (${signal ?? `code ${code}`})`);
		for (const pending of [...this.pending.values()]) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
		this.emit("exit", { code, signal });
		for (const resolve of this.closeWaiters.splice(0)) resolve();
		if (this.initialization?.child === child) {
			// Startup close rejects its owner; only that initialization failure
			// may schedule the next attempt. Never race a second retry here.
			if (this.stopping) this.setStatus("stopped");
			return;
		}
		if (this.restarting) {
			this.restarting = false;
			return;
		}
		if (this.initialStartPending) {
			this.initialStartPending = false;
			return;
		}
		if (this.stopping) {
			this.setStatus("stopped");
			return;
		}
		this.log(`agent exited unexpectedly (${signal ?? `code ${code}`})`);
		this.scheduleRestart();
	}

	scheduleRestart() {
		if (this.stopping || this.restartTimer !== undefined || this.initialization || this.child) return;
		if (this.spawnedAt && Date.now() - this.spawnedAt > this.stableMs) this.attempts = 0;
		const delay = this.backoffMs[Math.min(this.attempts, this.backoffMs.length - 1)] ?? 1000;
		this.attempts += 1;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.stopping || this.child || this.initialization) return;
			this.spawnAndInitialize().catch((error) => {
				this.log(`agent restart failed: ${error.message}`);
				if (!this.child && !this.stopping) this.scheduleRestart();
			});
		}, delay);
		this.setStatus("restarting");
	}

	setStatus(state) {
		if (this.status === state) return;
		this.status = state;
		this.emit("status", { state });
	}
}

module.exports = { AgentEngine, JsonlDecoder, encodeRecord, windowsPackageCliJs };

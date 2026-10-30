"use strict";

/**
 * Island agent server (U3): a local Unix-domain-socket JSONL server that
 * lets the island UI drive the supervised engine (runtime.cjs), the account
 * manager (auth.cjs) and the profile store (profiles.cjs).
 *
 * Secure by construction: a private 0700 directory holds a 0600 socket; the
 * first frame must be a hello carrying the per-launch capability token held
 * by the host; frames are LF-split, size-, rate- and queue-bounded; failures
 * close the connection without detail. Pi events are translated through the
 * allowlist in protocol.cjs; nothing raw is forwarded.
 *
 * Socket discipline adapted from apps/desktop/transport.cjs; handshake and
 * message names from Gentle Dot (MIT); see THIRD-PARTY-NOTICES.md.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const P = require("./protocol.cjs");
const { awaitSafePoint, closedToast } = require("./interrupt.cjs");

const DEFAULTS = {
	handshakeMs: 3000,
	maxClients: 2,
	framesPerMinute: 240,
	maxOutboundBytes: 1024 * 1024,
	askTimeoutMs: 120_000,
	maxPendingAsks: 16,
	/** Minimum time between two connectors snapshots (spawns); the outcome is cached for it. */
	connectorsMinIntervalMs: 1000,
	/** #378: bound for waiting out an interrupted turn before a permission change may be applied. */
	interruptSafePointMs: 30_000,
	/** Minimum time between two /proc session scans (#360); the snapshot is cached for it. */
	sessionsMinIntervalMs: 2000,
};
/** sockaddr_un.sun_path holds 108 bytes including the NUL on Linux and 104 on macOS. */
const MAX_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;
/**
 * Windows (W1): the endpoint is a named pipe `\\.\pipe\abito-<32 hex>` (libuv has no AF_UNIX
 * listener there). Node cannot set a DACL on it and the default pipe DACL lets other local
 * principals open it, so the gate is: nothing is ever sent before a valid token, and a client
 * that has not sent one within WIN_HANDSHAKE_MS is dropped. The Rust client additionally
 * verifies the server pid/SID before sending the token.
 */
const WIN = process.platform === "win32";
const WIN_HANDSHAKE_MS = 2000;

/**
 * #379 global pause: verbs refused with error{paused} while the switch is on —
 * agent-turn admission (send/steer/new_conversation) and every verb that spawns
 * a process (agent_connect, connectors_list, agents_list). Stopping or reading
 * work (abort, agent_disconnect, every read-only query) stays allowed.
 */
const PAUSED_REFUSED = new Set(["send", "steer", "new_conversation", "agent_connect", "hooks_install", "hooks_remove", "connectors_list", "agents_list"]);

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function generateToken() {
	return crypto.randomBytes(32).toString("base64url");
}

function tokensEqual(expected, given) {
	// Hash both sides so the compare is constant length and timing-safe.
	const a = crypto.createHash("sha256").update(expected).digest();
	const b = crypto.createHash("sha256").update(typeof given === "string" ? given : "").digest();
	return crypto.timingSafeEqual(a, b);
}

function privateDir(dir) {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private directory required");
	if (uid() !== undefined && stat.uid !== uid()) throw new Error("Private directory required");
	if (!WIN && (stat.mode & 0o7777) !== 0o700) throw new Error("Private directory required");
	return stat;
}

function sameIdentity(a, b) {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Removes leftover `p-*` endpoints of dead servers (nobody accepts on the socket). */
async function removeStale(runtimeDir) {
	if (WIN) return; // pipes vanish with their server: no leftover endpoints
	for (const name of fs.readdirSync(runtimeDir)) {
		if (!/^p-[A-Za-z0-9]{6}$/.test(name)) continue;
		const dir = path.join(runtimeDir, name);
		let dirStat;
		try {
			dirStat = fs.lstatSync(dir);
			if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (uid() !== undefined && dirStat.uid !== uid())) continue;
			if ((dirStat.mode & 0o7777) !== 0o700) continue;
		} catch {
			continue;
		}
		const endpoint = path.join(dir, "s");
		let sockStat;
		try {
			sockStat = fs.lstatSync(endpoint);
		} catch {
			sockStat = undefined;
		}
		if (sockStat) {
			if (!sockStat.isSocket() || sockStat.isSymbolicLink()) continue;
			const alive = await new Promise((resolve) => {
				const probe = net.connect(endpoint);
				probe.once("connect", () => {
					probe.destroy();
					resolve(true);
				});
				probe.once("error", (error) => resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"));
			});
			if (alive) continue;
			const again = fs.lstatSync(endpoint);
			if (!sameIdentity(again, sockStat)) continue;
			fs.unlinkSync(endpoint);
		}
		try {
			const current = fs.lstatSync(dir);
			if (sameIdentity(current, dirStat)) fs.rmdirSync(dir);
		} catch {
			// non-empty or raced: leave it
		}
	}
}

class IslandServer {
	/**
	 * @param {object} options
	 * @param {string} options.runtimeDir  private (0700) directory that will hold the socket directory
	 * @param {string} options.token       per-launch capability (see IslandServer.generateToken)
	 * @param {object} options.engine      AgentEngine-like (EventEmitter: status/event/exit; request, send, status)
	 * @param {object} [options.accounts]  AccountManager-like (EventEmitter: auth_*)
	 * @param {object} [options.profiles]  ProfileStore-like
	 * @param {object} [options.connectors] {snapshot(): Promise<{catalog, connectors}>}; read-only, persisted data
	 * @param {object} [options.sessions] {snapshot(): Promise<{sessions, truncated}>}; read-only /proc discovery (#360)
	 * @param {object} [options.connectorsControl] live connectors control adapter; reachable ONLY through this authenticated channel
	 * @param {object} [options.agents]     {list(), connect(id, planHash), disconnect(id)} (AgentsManager-like; EventEmitter 'change' = working-state push). Reachable ONLY via this channel.
	 * @param {object} [options.settings]  {get(): {hotkey}, setHotkey(value)}; a ConfigError from setHotkey -> bad_request
	 * @param {boolean} [options.paused]   #379 initial global pause state (restored from config at daemon boot)
	 * @param {object} [options.pausedStore] {get(): boolean, set(value)} persistence for the pause switch; a throw -> failed and no change
	 * @param {((message:string)=>string|{message:string,commit?:()=>void})} [options.promptDecorator] #386 (R6: may return {message, commit}; commit runs after the engine accepted the prompt): rewrites the send frame's message just before the prompt (pending rotation summary); no decorator = identity
	 * @param {(()=>void)} [options.onNewConversation] #386: called after a successful new_conversation (drops an undelivered summary)
 * @param {(()=>({at:number,turnActive:boolean,asks:number}|undefined))} [options.interruptedRecord] R5: reads the unconsumed interrupted-work record (bounded closed fields); exposed once in the ready frame
 * @param {(()=>boolean)} [options.onInterruptedAck] R5: marks the exposed record consumed; runs only after a client sends interrupted_ack. R4 (RDD): returns true on success (or when nothing is left to consume); a false result or a throw makes the server answer the failed error frame and keep the record pending for a retry
	 */
	constructor(options) {
		if (typeof options.token !== "string" || options.token.length < 16) throw new Error("A launch token of 16+ characters is required");
		this.token = options.token;
		this.runtimeDir = path.resolve(options.runtimeDir);
		this.engine = options.engine;
		this.accounts = options.accounts;
		this.profiles = options.profiles;
		this.settings = options.settings;
		this.connectors = options.connectors;
		this.mcpImport = options.mcpImport;
		this.sessions = options.sessions;
		this.connectorsControl = options.connectorsControl;
		this.agents = options.agents;
		this.agentHooks = options.agentHooks; // #361 {preview(), install(id, hash), remove(id, hash)}
		this.paused = options.paused === true; // #379 global pause switch; admission guards in handle()
		this.promptDecorator = options.promptDecorator; // #386 pending rotation summary (no decorator = identity)
		this.interruptedRecord = options.interruptedRecord; // R5
		this.onInterruptedAck = options.onInterruptedAck; // R5
		this.pendingInterrupted = undefined;
		this.onNewConversation = options.onNewConversation; // #386 drops an undelivered summary
		this.pausedStore = options.pausedStore;
		this.connectorsFlight = undefined; // the single in-flight snapshot promise (shared by all clients)
		this.connectorsLast = undefined; // {at, outcome: Promise-settled frame | undefined}
		this.sessionsFlight = undefined; // #360: the single in-flight scan promise (shared by all clients)
		this.sessionsLast = undefined; // #360: {at, promise} served from cache inside the min interval
		this.opts = { ...DEFAULTS, ...(options.limits ?? {}) };
		this.log = options.log ?? (() => {});
		this.clients = new Set();
		this.busy = false;
		this.switching = undefined; // the single in-flight profile/role selection
		this.authFlow = undefined; // last sign-in flow seen: {flowId, accountId, method, phase}
		this.authEarly = undefined; // phase of a flow whose auth_start reply has not landed yet
		this.messageCounter = 0;
		this.asks = new Map();
		this.server = undefined;
		this.endpoint = undefined;
		this.directory = undefined;
		this.closing = undefined;
		this.listeners = [];
	}

	static generateToken() {
		return generateToken();
	}

	get messageId() {
		return `m${this.messageCounter}`;
	}

	state() {
		return { busy: this.busy || this.engine?.busy === true || this.switching !== undefined, status: this.engine?.status ?? "stopped", paused: this.paused === true };
	}

	async start() {
		if (this.server) throw new Error("already started");
		try {
			fs.mkdirSync(this.runtimeDir, { mode: 0o700 });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		privateDir(this.runtimeDir);
		await removeStale(this.runtimeDir);
		if (WIN) return this.startPipe();
		const directory = fs.mkdtempSync(path.join(this.runtimeDir, "p-"));
		this.directory = directory;
		try {
			this.directoryStat = privateDir(directory);
		} catch (error) {
			this.cleanup();
			throw error;
		}
		const endpoint = path.join(directory, "s");
		try {
			if (Buffer.byteLength(endpoint) > MAX_SOCKET_PATH) throw new Error("Unix endpoint path too long");
			this.server = net.createServer((socket) => this.onConnection(socket));
			await new Promise((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(endpoint, resolve);
			});
			fs.chmodSync(endpoint, 0o600);
			const stat = fs.lstatSync(endpoint);
			if (!stat.isSocket() || (stat.mode & 0o7777) !== 0o600) throw new Error("Unsafe socket");
			this.socketStat = stat;
			this.endpoint = endpoint;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
		// R5: read the unconsumed interrupted-work record once per boot; it is
		// exposed in every ready frame until a client acknowledges it.
		this.pendingInterrupted = this.interruptedRecord?.() ?? undefined;
		this.attach();
		return { endpoint };
	}

	/** Windows listener: a named pipe, no directory, no socket file. */
	async startPipe() {
		const endpoint = `\\\\.\\pipe\\abito-${crypto.randomBytes(16).toString("hex")}`;
		this.server = net.createServer((socket) => this.onConnection(socket));
		try {
			await new Promise((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(endpoint, resolve);
			});
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
		this.endpoint = endpoint;
		this.pendingInterrupted = this.interruptedRecord?.() ?? undefined;
		this.attach();
		return { endpoint };
	}

	attach() {
		const on = (emitter, name, fn) => {
			if (!emitter?.on) return;
			emitter.on(name, fn);
			this.listeners.push(() => emitter.off(name, fn));
		};
		on(this.engine, "event", (event) => this.onEngineEvent(event));
		on(this.engine, "status", () => this.onEngineStatus());
		on(this.engine, "exit", () => this.onEngineStatus(true));
		on(this.engine, "turn_cancelled", ({ reason }) => {
			for (const id of [...this.asks.keys()]) this.closeAsk(id, false);
			// #378: the copy is fixed and sanitized; engine text never reaches a client.
			this.broadcast(closedToast(reason));
		});
		// Intermediate states (an operation started => "working") reach every client.
		on(this.agents, "change", (entries) => {
			try {
				this.broadcast(P.agentsFrame(entries));
			} catch {
				this.log("agents change not sent");
			}
		});
		on(this.accounts, "auth_prompt", (p) => {
			this.trackAuth(p?.flowId, "prompt");
			this.broadcast(P.authPromptFrame(p));
		});
		on(this.accounts, "auth_event", (e) => {
			this.trackAuth(e?.flowId, "progress");
			this.broadcast(P.authEventFrame(e));
		});
		on(this.accounts, "auth_done", (d) => {
			this.trackAuth(d?.flowId, "done");
			this.broadcast(P.authDoneFrame(d));
		});
		on(this.connectorsControl, "pending", (items) => {
			try { this.broadcast(P.pendingFrame({ items })); } catch { this.log("connector pending not sent"); }
		});
		on(this.connectorsControl, "connectors", (data) => {
			try { this.broadcast(P.connectorsFrame(data)); } catch { this.log("live connectors not sent"); }
		});
		on(this.connectorsControl, "auth_prompt", (prompt) => {
			try { this.broadcast(P.authPromptFrame(prompt)); } catch { this.log("connector prompt not sent"); }
		});
		on(this.connectorsControl, "auth_done", (done) => {
			try { this.broadcast(P.authDoneFrame(done)); } catch { this.log("connector auth result not sent"); }
		});
	}

	/** Records the phase of the current flow from the last auth_* frame (for late clients). */
	trackAuth(flowId, phase) {
		if (typeof flowId !== "string") return;
		if (this.authFlow?.flowId === flowId) this.authFlow.phase = phase;
		else this.authEarly = { flowId, phase };
	}

	// ----- connections -------------------------------------------------------

	onConnection(socket) {
		if (this.clients.size >= this.opts.maxClients || this.closing) {
			socket.destroy();
			return;
		}
		const client = { socket, ready: false, seq: 0, pending: Buffer.alloc(0), frames: 0, windowStart: Date.now(), dead: false };
		this.clients.add(client);
		client.handshake = setTimeout(() => this.drop(client), WIN ? Math.min(this.opts.handshakeMs, WIN_HANDSHAKE_MS) : this.opts.handshakeMs);
		socket.on("error", () => this.drop(client));
		socket.on("close", () => {
			clearTimeout(client.handshake);
			client.dead = true;
			this.clients.delete(client);
		});
		socket.on("data", (chunk) => this.onData(client, chunk));
	}

	drop(client) {
		client.dead = true;
		clearTimeout(client.handshake);
		client.socket.destroy();
	}

	onData(client, chunk) {
		if (client.dead) return;
		const maxLine = client.ready ? P.LIMITS.maxFrameBytes : P.LIMITS.maxHelloBytes;
		if (client.pending.length + chunk.length > maxLine * 4 + 4) return this.drop(client);
		client.pending = Buffer.concat([client.pending, chunk]);
		let end;
		while (!client.dead && (end = client.pending.indexOf(0x0a)) !== -1) {
			const line = client.pending.subarray(0, end);
			client.pending = client.pending.subarray(end + 1);
			const limit = client.ready ? P.LIMITS.maxFrameBytes : P.LIMITS.maxHelloBytes;
			if (line.length > limit) return this.drop(client);
			if (line.length === 0) continue;
			const now = Date.now();
			if (now - client.windowStart >= 60_000) {
				client.frames = 0;
				client.windowStart = now;
			}
			if (++client.frames > this.opts.framesPerMinute) {
				if (client.ready) this.sendTo(client, P.errorFrame("rate_limited"));
				return this.drop(client);
			}
			if (!client.ready) {
				this.onHello(client, line);
			} else {
				const decoded = P.decodeClientLine(line);
				if (decoded.error) this.sendTo(client, P.errorFrame("bad_request"));
				else this.handle(client, decoded.frame).catch(() => this.sendTo(client, P.errorFrame("failed")));
			}
		}
		if (!client.dead && client.pending.length > (client.ready ? P.LIMITS.maxFrameBytes : P.LIMITS.maxHelloBytes)) this.drop(client);
	}

	onHello(client, line) {
		const decoded = P.decodeClientLine(line, { expectHello: true });
		// Same silent close for every failure; compare the token even on protocol mismatch.
		const tokenOk = decoded.frame ? tokensEqual(this.token, decoded.frame.token) : false;
		if (!decoded.frame || decoded.frame.protocol !== P.PROTOCOL || !tokenOk) return this.drop(client);
		clearTimeout(client.handshake);
		client.ready = true;
		this.sendTo(client, {
			type: "ready",
			protocol: P.PROTOCOL,
			state: this.state(),
			limits: { maxFrameBytes: P.LIMITS.maxFrameBytes, maxClients: this.opts.maxClients },
			features: { history: false },
			// R5: the unconsumed interrupted-work record, bounded closed fields
			// (counts and time only); absent once a client acknowledged it.
			...(this.pendingInterrupted ? { interrupted: this.pendingInterrupted } : {}),
		});
		for (const ask of this.asks.values()) this.sendTo(client, this.askFrame(ask));
	}

	// ----- outbound ----------------------------------------------------------

	sendTo(client, frame) {
		if (client.dead || client.socket.destroyed) return;
		if (client.socket.writableLength > this.opts.maxOutboundBytes) return this.drop(client);
		client.seq += 1;
		client.socket.write(P.encodeServerFrame(frame, client.seq));
		if (client.socket.writableLength > this.opts.maxOutboundBytes) this.drop(client);
	}

	broadcast(frame) {
		for (const client of [...this.clients]) if (client.ready) this.sendTo(client, frame);
	}

	backsActiveProfile(accountId) {
		try {
			const { profiles, active } = this.profiles.list();
			return profiles.some((p) => p.id === active && p.accountId === accountId);
		} catch {
			return false;
		}
	}

	/** Pushes the current settings to every client (daemon: file edit picked up by SIGHUP). */
	broadcastSettings() {
		if (!this.settings) return;
		try {
			this.broadcast(P.settingsFrame(this.settings.get()));
		} catch {
			this.log("could not read settings");
		}
	}

	/**
	 * The connectors frame for connectors_list. At most one snapshot in flight (clients share the
	 * promise) and at least `connectorsMinIntervalMs` between spawns: inside the window the last
	 * outcome (frame or failure) is served from cache, so a client cannot fork-bomb the host.
	 * Returns the frame or throws (the caller replies a generic `failed`).
	 */
	connectorsOutcome() {
		if (this.connectorsFlight) return this.connectorsFlight;
		const last = this.connectorsLast;
		if (last && Date.now() - last.at < this.opts.connectorsMinIntervalMs) return last.promise;
		const promise = (async () => P.connectorsFrame(await this.connectors.snapshot()))();
		const entry = { at: Date.now(), promise };
		this.connectorsFlight = promise;
		this.connectorsLast = entry;
		const settle = () => {
			this.connectorsFlight = undefined;
			entry.at = Date.now(); // the window runs from completion, so spawns are always >= the interval apart
		};
		promise.then(settle, settle);
		return promise;
	}

	/**
	 * The sessions frame for sessions_list (#360). Same discipline as connectors: at most one scan
	 * in flight (clients share the promise) and at least `sessionsMinIntervalMs` between scans:
	 * inside the window the last outcome (frame or failure) is served from cache, so clients cannot
	 * make the daemon hammer /proc. Returns the frame or throws (the caller replies a generic `failed`).
	 */
	async sessionsOutcome() {
		const frame = await this.sessionsSnapshotOutcome();
		const stream = this.currentToolStream();
		const tools = stream?.history.view();
		return P.sessionsFrame({ sessions: frame.sessions.map(row => tools && row.id === stream.id ? { ...row, tools: { ...tools, epoch: this.engine.sessionEpoch ?? 0 } } : row), truncated: frame.truncated });
	}

	currentToolStream() {
		const key = this.engine?.pid && this.engine?.sessionFile ? `${this.engine.pid}:${this.engine.sessionEpoch}:${this.engine.sessionFile}` : null;
		if (this.toolStream?.key !== key) this.toolStream = undefined;
		return this.toolStream;
	}

	sessionsSnapshotOutcome() {
		if (this.sessionsFlight) return this.sessionsFlight;
		const last = this.sessionsLast;
		if (last && Date.now() - last.at < this.opts.sessionsMinIntervalMs) return last.promise;
		const promise = (async () => P.sessionsFrame(await this.sessions.snapshot()))();
		const entry = { at: Date.now(), promise };
		this.sessionsFlight = promise;
		this.sessionsLast = entry;
		const settle = () => {
			this.sessionsFlight = undefined;
			entry.at = Date.now(); // the window runs from completion, so scans are always >= the interval apart
		};
		promise.then(settle, settle);
		return promise;
	}

	broadcastState() {
		this.broadcast({ type: "agent_state", ...this.state() });
	}

	// ----- engine events -------------------------------------------------------

	onEngineEvent(event) {
		let stream = this.currentToolStream();
		if (!stream && event?.type === 'tool_execution_start' && this.engine?.sessionFile) {
			const { ToolHistory, sessionIdForPid } = require('./sessions.cjs');
			const id = sessionIdForPid(this.engine.pid);
			if (id) this.toolStream = stream = { id, key: `${this.engine.pid}:${this.engine.sessionEpoch}:${this.engine.sessionFile}`, history: new ToolHistory() };
		}
		stream?.history.accept(event);
		const out = P.translateEvent(event, this.messageId);
		if (out.busy !== undefined && out.busy !== this.busy) {
			this.busy = out.busy;
			this.broadcastState();
		}
		for (const frame of out.frames) this.broadcast(frame);
		if (out.messageDone) this.messageCounter += 1;
		if (out.ask) this.openAsk(out.ask);
		if (out.cancelUi) this.safeSend({ type: "extension_ui_response", id: out.cancelUi, cancelled: true });
	}

	onEngineStatus(exited = false) {
		const status = this.engine?.status;
		if (exited || status !== "ready") {
			// A half answer is never replayed; open asks die with the child.
			// Daemon workspace/config guards consume this canonical field too.
			this.busy = this.engine?.busy === true;
			this.messageCounter += 1;
			for (const id of [...this.asks.keys()]) this.closeAsk(id, false);
		} else if (typeof this.engine?.busy === "boolean" && this.switching === undefined) {
			this.busy = this.engine.busy; // Readiness/verified session, not an ACK alone.
		}
		this.broadcastState();
	}

	safeSend(record) {
		try {
			this.engine.send(record);
			return true;
		} catch {
			return false;
		}
	}

	// ----- asks (extension UI) ---------------------------------------------------

	askFrame(ask) {
		return { type: "ask", id: ask.id, kind: ask.kind, title: ask.title, options: ask.options };
	}

	openAsk(ask) {
		if (this.asks.has(ask.id) || this.asks.size >= this.opts.maxPendingAsks) {
			this.safeSend({ type: "extension_ui_response", id: ask.id, cancelled: true });
			return;
		}
		ask.timer = setTimeout(() => {
			this.safeSend({ type: "extension_ui_response", id: ask.id, cancelled: true });
			this.closeAsk(ask.id, false);
		}, this.opts.askTimeoutMs);
		ask.timer.unref?.();
		this.asks.set(ask.id, ask);
		this.broadcast(this.askFrame(ask));
	}

	closeAsk(id, _answered) {
		const ask = this.asks.get(id);
		if (!ask) return;
		clearTimeout(ask.timer);
		this.asks.delete(id);
		this.broadcast({ type: "ask_resolved", id });
	}

	// ----- client commands ---------------------------------------------------------

	async handle(client, frame) {
		const reply = (f) => this.sendTo(client, f);
		const fail = (code) => reply(P.errorFrame(code));
		// #379: while the global pause is on, nothing new is admitted (turns, spawns).
		if (this.paused === true && PAUSED_REFUSED.has(frame.type)) return fail("paused");
		const ready = () => this.engine?.status === "ready";
		const run = async (fn) => {
			try {
				return await fn();
			} catch (error) {
				this.log(`command ${frame.type} failed`);
				fail(error?.code === "store_not_private" ? "store_not_private" : /busy/i.test(String(error?.message)) ? "busy" : "failed");
				return undefined;
			}
		};
		const runConnector = async (fn) => {
			try { return await fn(); }
			catch (error) {
				this.log("connector control command failed");
				fail(error?.name === "ConnectorsControlError" ? error.code : "failed");
				return undefined;
			}
		};
		switch (frame.type) {
			case "status":
				return reply({ type: "agent_state", ...this.state() });
			case "interrupted_ack": {
				// R5: acknowledges the exposed interrupted-work record. Consumption
				// happens here and only here (never at boot); idempotent afterwards.
				// R4 (RDD): the record stays pending until persistence SUCCEEDS; a
				// failed write answers the failed error frame and leaves the state
				// untouched so a retry persists it.
				if (this.pendingInterrupted === undefined) return reply({ type: "interrupted_acknowledged" });
				let consumed = false;
				try {
					consumed = this.onInterruptedAck?.() !== false;
				} catch {
					consumed = false;
				}
				if (!consumed) {
					this.log("interrupted record ack failed");
					return fail("failed");
				}
				this.pendingInterrupted = undefined;
				return reply({ type: "interrupted_acknowledged" });
			}
			case "set_paused": {
				// #379: one global switch. Persistence first: a failed write leaves the
				// previous state (in memory AND on disk) untouched and answers failed.
				if (frame.paused === this.paused) return reply({ type: "agent_state", ...this.state() });
				try {
					this.pausedStore?.set(frame.paused);
				} catch {
					this.log("command set_paused failed");
					return fail("failed");
				}
				this.paused = frame.paused;
				// #378: an in-flight turn is interrupted through the engine's cancellation
				// path (admission closes, open asks resolve, the child is recycled, the
				// session reopens, no replay). Idling pause sends nothing.
				if (frame.paused && this.state().busy) this.engine?.interruptTurn?.("paused");
				this.broadcastState();
				return undefined;
			}
			case "send": {
				if (!ready()) return fail("unavailable");
				if (this.state().busy) return fail("busy");
				this.busy = true; // optimistic: the agent_start event confirms
				this.broadcastState();
				try {
					// #386: the pending rotation summary (if any) prepends here, exactly once.
					// R6: a decorator may return { message, commit }; commit runs only after the engine accepted the prompt.
					const decorated = this.promptDecorator ? this.promptDecorator(frame.text) : frame.text;
					const message = typeof decorated === "string" ? decorated : decorated.message;
					const command = { type: "prompt", message };
					if (frame.images.length) command.images = frame.images;
					// The response only acknowledges the prompt; completion is agent_settled.
					await this.engine.request(command);
					if (typeof decorated !== "string") decorated.commit?.();
				} catch {
					// A lost ACK may already have started Pi work; the runtime owns
					// cutoff/recovery. An old rejection cannot free a new turn.
					if (ready() && this.engine.busy !== true) this.busy = false;
					this.broadcastState();
					fail("failed");
				}
				return undefined;
			}
			case "steer":
				if (!ready()) return fail("unavailable");
				if (this.switching) return fail("busy");
				if (!this.busy) return fail("not_busy");
				return run(() => this.engine.request({ type: "steer", message: frame.text }));
			case "abort":
				if (!ready()) return fail("unavailable");
				return run(() => this.engine.request({ type: "abort" }));
			case "new_conversation": {
				if (!ready()) return fail("unavailable");
				if (this.state().busy) return fail("busy");
				const switching = {};
				this.switching = switching;
				this.busy = true; // Daemon config/workspace guards share this field.
				this.broadcastState();
				try {
					await run(async () => {
						await this.engine.request({ type: "new_session" });
						this.messageCounter += 1;
						// #386: a deliberate new conversation drops an undelivered summary.
						this.onNewConversation?.();
					});
				} finally {
					if (this.switching === switching) {
						this.switching = undefined;
						this.busy = this.engine?.busy === true;
						this.broadcastState();
					}
				}
				return undefined;
			}
			case "ui_response": {
				const ask = this.asks.get(frame.id);
				if (!ask) return fail("unknown_ask");
				const response = P.buildUiResponse(ask, frame);
				if (!response) return fail("bad_request");
				if (!this.safeSend(response)) return fail("unavailable");
				this.closeAsk(frame.id, true);
				return undefined;
			}
			case "settings_get":
				if (!this.settings) return fail("unavailable");
				return run(async () => reply(P.settingsFrame(this.settings.get())));
			case "settings_set":
				if (!this.settings) return fail("unavailable");
				try {
					await this.settings.setHotkey(frame.hotkey);
				} catch (error) {
					this.log("command settings_set failed");
					return fail(error?.name === "ConfigError" ? "bad_request" : "failed");
				}
				return run(async () => this.broadcast(P.settingsFrame(this.settings.get())));
			case "connectors_list":
				if (!this.connectors) return fail("unavailable");
				try {
					reply(await this.connectorsOutcome());
				} catch {
					this.log("command connectors_list failed");
					fail("failed");
				}
				return undefined;
			case "mcp_import_preview":
				if (!this.mcpImport) return fail("unavailable");
				try {
					reply(P.mcpImportFrame(await this.mcpImport.preview()));
				} catch {
					this.log("command mcp_import_preview failed");
					fail("failed");
				}
				return undefined;
			case "sessions_list":
				// Read-only /proc scan (#360): like every read, it still answers while paused.
				if (!this.sessions) return fail("unavailable");
				try {
					reply(await this.sessionsOutcome());
				} catch {
					this.log("command sessions_list failed");
					fail("failed");
				}
				return undefined;
			case "connectors_pending":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(async () => reply(P.pendingFrame({ items: await this.connectorsControl.pending() })));
			case "connectors_approve":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(() => this.connectorsControl.approve(frame.proposal_id, frame.digest));
			case "connectors_deny":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(() => this.connectorsControl.deny(frame.proposal_id));
			case "connectors_connect":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(async () => {
					const started = await this.connectorsControl.connect(frame.connector_id);
					reply({ type: "auth_started", flowId: started.flowId, connector_id: frame.connector_id });
				});
			case "connectors_disconnect":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(() => this.connectorsControl.disconnect(frame.connector_id));
			case "connectors_mode":
				if (!this.connectorsControl) return fail("unavailable");
				return runConnector(() => this.connectorsControl.setMode(frame.connector_id, frame.mode));
			case "agents_list":
				if (!this.agents) return fail("unavailable");
				try {
					reply(P.agentsFrame(await this.agents.list()));
				} catch {
					this.log("command agents_list failed");
					fail("failed");
				}
				return undefined;
			case "agent_connect":
			case "agent_disconnect":
				// The result is broadcast to EVERY client (the island shows one shared state). A busy
				// manager (one global operation at a time) answers `busy`; any other failure is generic.
				if (!this.agents) return fail("unavailable");
				try {
					const entries = frame.type === "agent_connect" ? await this.agents.connect(frame.agentId, frame.plan_hash) : await this.agents.disconnect(frame.agentId);
					this.broadcast(P.agentsFrame(entries));
				} catch (error) {
					this.log(`command ${frame.type} failed`);
					fail(error?.code === "busy" ? "busy" : "failed");
				}
				return undefined;
			case "hooks_preview":
				// Read-only (#361): never writes; still answers while paused like every read.
				if (!this.agentHooks) return fail("unavailable");
				try {
					reply(P.hooksFrame(await this.agentHooks.preview()));
				} catch {
					this.log("command hooks_preview failed");
					fail("failed");
				}
				return undefined;
			case "hooks_install":
			case "hooks_remove":
				// Explicit verbs only: install needs the exact plan_hash the caller was shown. The outcome is
				// broadcast to every client (shared state), like agent_connect.
				if (!this.agentHooks) return fail("unavailable");
				try {
					const out = frame.type === "hooks_install" ? await this.agentHooks.install(frame.clientId, frame.plan_hash) : await this.agentHooks.remove(frame.clientId, frame.plan_hash);
					if (out.result?.code === "bad_request") return fail("bad_request");
					this.broadcast(P.hooksFrame(out));
				} catch {
					this.log(`command ${frame.type} failed`);
					fail("failed");
				}
				return undefined;
			case "accounts_list":
				if (!this.accounts) return fail("unavailable");
				return reply(P.accountsFrame(this.accounts.listAccounts()));
			case "providers_list":
				if (!this.accounts) return fail("unavailable");
				return run(async () => reply(P.providersFrame(await this.accounts.providers())));
			case "models_list":
				if (!this.accounts) return fail("unavailable");
				return run(async () => reply(P.modelsFrame(await this.accounts.models(frame.providerId, frame.accountId))));
			case "profiles_list":
				if (!this.profiles) return fail("unavailable");
				return run(async () => reply(P.profilesFrame(this.profiles.list(), this.profiles.roles())));
			case "account_create":
				if (!this.accounts) return fail("unavailable");
				return run(async () => {
					const input = { provider: frame.provider, label: frame.label };
					if (frame.accountId !== undefined) input.accountId = frame.accountId;
					const account = await this.accounts.createAccount(input);
					reply(P.accountFrame(account));
					this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
				});
			case "local_account_create":
				if (!this.accounts?.createLocalAccount) return fail("unavailable");
				return run(async () => {
					const { type: _type, ...input } = frame;
					reply(P.accountFrame(await this.accounts.createLocalAccount(input)));
					this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
				});
			case "local_endpoint_set":
				if (!this.accounts?.setLocalEndpoint) return fail("unavailable");
				// Takes effect on the NEXT profile_select; the live agent files are never touched here.
				if (this.profiles && this.backsActiveProfile(frame.accountId) && this.state().busy) return fail("busy");
				return run(async () => {
					const { type: _type, ...input } = frame;
					reply(P.accountFrame(await this.accounts.setLocalEndpoint(input)));
					this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
				});
			case "custom_account_create":
			case "custom_endpoint_set":
			case "custom_models_refresh": {
				const method = { custom_account_create: "createCustomAccount", custom_endpoint_set: "setCustomEndpoint", custom_models_refresh: "refreshCustomModels" }[frame.type];
				if (!this.accounts?.[method]) return fail("unavailable");
				// Configuration only: never touches the live agent files, and the account cannot be activated.
				return run(async () => {
					const { type: _type, ...input } = frame;
					reply(P.accountFrame(await this.accounts[method](input)));
					this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
				});
			}
			case "account_remove":
			case "account_logout":
				if (!this.accounts) return fail("unavailable");
				if (frame.type === "account_logout" && this.profiles && this.backsActiveProfile(frame.accountId)) {
					// Logging out the active profile's account also deactivates that profile,
					// through the same guard as profile_deactivate.
					if (this.state().busy) {
						// #378: revoking the active account's access interrupts the in-flight
						// turn at the next safe point BEFORE the credential changes. No safe
						// point within the bound: `busy`, and nothing was touched.
						this.engine?.interruptTurn?.("access_revoked");
						if (!(await awaitSafePoint(() => this.state().busy, this.opts.interruptSafePointMs))) {
							this.log("command account_logout found no safe point");
							return fail("busy");
						}
					}
					this.switching = (async () => {
						await run(async () => {
							await this.accounts.logout(frame.accountId);
							await this.profiles.deactivate();
							this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
							this.broadcast(P.profilesFrame(this.profiles.list(), this.profiles.roles()));
						});
					})();
					this.broadcastState();
					try {
						await this.switching;
					} finally {
						this.switching = undefined;
						this.broadcastState();
					}
					return undefined;
				}
				return run(async () => {
					if (frame.type === "account_remove") await this.accounts.removeAccount(frame.accountId);
					else await this.accounts.logout(frame.accountId);
					this.broadcast(P.accountsFrame(this.accounts.listAccounts()));
				});
			case "account_status":
				if (!this.accounts) return fail("unavailable");
				return run(async () => reply(P.accountFrame(await this.accounts.status(frame.accountId))));
			case "profile_save":
				if (!this.profiles) return fail("unavailable");
				return run(async () => {
					const { type: _type, ...input } = frame;
					await this.profiles.save(input);
					this.broadcast(P.profilesFrame(this.profiles.list(), this.profiles.roles()));
				});
			case "profile_remove":
				if (!this.profiles) return fail("unavailable");
				return run(async () => {
					await this.profiles.remove(frame.id);
					this.broadcast(P.profilesFrame(this.profiles.list(), this.profiles.roles()));
				});
			case "auth_state":
				if (!this.accounts) return fail("unavailable");
				return reply(P.authStateFrame(this.authFlow));
			case "profile_select":
			case "profile_deactivate":
			case "role_select":
				if (!this.profiles) return fail("unavailable");
				if (this.state().busy) return fail("busy");
				// One selection at a time; the engine reads as busy until it settles.
				this.switching = (async () => {
					await run(async () => {
						if (frame.type === "profile_select") await this.profiles.select(frame.id);
						else if (frame.type === "profile_deactivate") await this.profiles.deactivate();
						else await this.profiles.selectForRole(frame.role);
						this.broadcast(P.profilesFrame(this.profiles.list(), this.profiles.roles()));
					});
				})();
				this.broadcastState();
				try {
					await this.switching;
				} finally {
					this.switching = undefined;
					this.broadcastState();
				}
				return undefined;
			case "auth_start":
				if (!this.accounts) return fail("unavailable");
				return run(async () => {
					const started = await this.accounts.startLogin({ accountId: frame.accountId, method: frame.method });
					const flowId = String(started?.flowId ?? "").slice(0, 128);
					const early = this.authEarly?.flowId === flowId ? this.authEarly.phase : "starting";
					this.authEarly = undefined;
					this.authFlow = { flowId, accountId: frame.accountId, method: frame.method, phase: early };
					reply({ type: "auth_started", flowId });
				});
			case "auth_reply":
				if (typeof frame.flowId === "string" && frame.flowId.startsWith("connector-setup-")) {
					if (!this.connectorsControl) return fail("unavailable");
					// Connector values travel only to the in-memory setup flow and then once to the host.
					return runConnector(() => this.connectorsControl.reply(frame.flowId, frame.promptId, frame.value));
				}
				if (!this.accounts) return fail("unavailable");
				// The value goes to the account manager only; it is never logged or echoed.
				return run(() => this.accounts.reply(frame.flowId, { promptId: frame.promptId, value: frame.value }));
			case "auth_cancel":
				if (typeof frame.flowId === "string" && frame.flowId.startsWith("connector-setup-")) {
					if (!this.connectorsControl) return fail("unavailable");
					return runConnector(() => this.connectorsControl.cancel(frame.flowId));
				}
				if (!this.accounts) return fail("unavailable");
				return run(() => this.accounts.cancel(frame.flowId));
			default:
				return fail("bad_request");
		}
	}

	// ----- shutdown -------------------------------------------------------------------

	/**
	 * #385 OD066 — read-only snapshot of the work a stop is about to lose,
	 * taken BEFORE close() drops the clients and closes the asks. It never
	 * carries a token nor any prompt content.
	 */
	snapshotInterruptions() {
		return {
			turnActive: this.state().busy === true,
			asks: [...this.asks.values()].map((ask) => ({ id: ask.id, kind: ask.kind, title: ask.title })),
		};
	}

	cleanup() {
		if (WIN) return; // no directory or socket file to remove
		const { directory, directoryStat, socketStat, endpoint } = this;
		if (!directory || !directoryStat) return;
		let current;
		try {
			current = fs.lstatSync(directory);
		} catch (error) {
			if (error.code === "ENOENT") {
				this.directory = undefined;
				return;
			}
			throw error;
		}
		if (!sameIdentity(current, directoryStat) || current.isSymbolicLink()) throw new Error("Cleanup identity changed");
		if (endpoint) {
			try {
				const sock = fs.lstatSync(endpoint);
				if (socketStat && sameIdentity(sock, socketStat) && sock.isSocket()) fs.unlinkSync(endpoint);
				else if (socketStat) throw new Error("Cleanup socket changed");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		fs.rmdirSync(directory);
		this.directory = undefined;
	}

	/** Stops listening, drops every client, clears timers and removes the socket and its directory. */
	close() {
		if (this.closing) return this.closing;
		this.closing = (async () => {
			for (const off of this.listeners.splice(0)) off();
			for (const id of [...this.asks.keys()]) {
				clearTimeout(this.asks.get(id).timer);
				this.asks.delete(id);
			}
			for (const client of this.clients) this.drop(client);
			if (this.server?.listening) await new Promise((resolve) => this.server.close(() => resolve()));
			this.cleanup();
		})();
		return this.closing;
	}
}

module.exports = { IslandServer, generateToken, tokensEqual };

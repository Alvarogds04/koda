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
// T2 white-label: internal /gentle: commands are refused at the island's prompt
// intake (Gentle Dot bridge.ts dispatch), with a fixed error, before any
// admission check. The user's own text is never otherwise rewritten here.
const { isBlockedInput, presentText } = require("./white-label.cjs");
const { awaitSafePoint, closedToast } = require("./interrupt.cjs");
// T4 U1: the history projection over the engine's rotated chain (Gentle Dot's
// conversations.ts, MIT); see THIRD-PARTY-NOTICES.md.
const { pageHistory, sessionTail, nextRow, splitAttachments, textOf } = require("./conversations.cjs");
// K2-05 attachments (L11 2a): Gentle Dot's upload store and prompt composition (uploads.ts, MIT).
const { UploadStore, composePrompt } = require("./uploads.cjs");

/** Gentle Dot's REMEMBERED_REQUEST_IDS (bridge.ts:122): a repeated send/steer requestId is ignored. */
const REMEMBERED_REQUEST_IDS = 500;
/** The steers the engine may still record in the running turn (each client's are bounded by the rate limit). */
const MAX_STEER_REQUESTS = 32;
/** K2-05 U4b: bounds of an ask's optional details (UTF-16 units, like every daemon clip). */
const ASK_MESSAGE_CHARS = 2000;
const ASK_PLACEHOLDER_CHARS = 200;

/**
 * K2-05 U4b: one optional harness-written ask detail as the island may show it (Gentle Dot
 * bridge.ts onUiRequest: `message` / `placeholder` pass through presentText). Rewrite FIRST,
 * clip SECOND (a clip first could cut a hidden name in half), control characters other than
 * tab/newline removed, never cut between the two halves of a surrogate pair. Anything but a
 * string is no detail at all.
 */
function askDetail(value, max) {
	if (typeof value !== "string") return undefined;
	const clean = presentText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
	if (clean.length <= max) return clean;
	let end = max;
	const prev = clean.charCodeAt(end - 1);
	if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
	return clean.slice(0, end);
}

/**
 * K2-05 U4b: the details a dialog shows next to its title — a confirm's `message` (what the
 * user approves) and an input's `placeholder` — added to the pending ask (additive, optional).
 * The user's ANSWER is never touched here: it travels to the engine as typed.
 */
function withAskDetails(ask, event) {
	const message = askDetail(event?.message, ASK_MESSAGE_CHARS);
	if (message) ask.message = message;
	if (ask.kind === "input") {
		const placeholder = askDetail(event?.placeholder, ASK_PLACEHOLDER_CHARS);
		if (placeholder) ask.placeholder = placeholder;
	}
	return ask;
}

/** K2-05 review F6: an error answering a send/steer carries its requestId (additive, sender only). */
const requestError = (code, requestId) => (requestId === undefined ? P.errorFrame(code) : { ...P.errorFrame(code), requestId });

const DEFAULTS = {
	handshakeMs: 3000,
	/** F1 (U2 re-verify): the cap counts ONLY authenticated live clients (the `auth` set,
	 * filled when a handshake is admitted and removed synchronously on close/destroy): the
	 * settings window + the chat + one reconnect overlap. A hello whose admission would
	 * exceed the cap is still ANSWERED its `ready` first and only then dropped silently,
	 * so the daemon's own health probe — and any burst of concurrent probes — is classified
	 * healthy while settings and chat are connected. */
	maxClients: 4,
	/** F1 (U2 re-verify): independent bound for PRE-hello connections (each also bounded by
	 * the handshake timeout): the connect-time client cap was removed in the U2 follow-up,
	 * which left a connect burst unbounded until its handshake window closed it. */
	maxHandshakes: 16,
	framesPerMinute: 240,
	/** K2-05 attachments: `upload` chunks have their OWN per-client budget (≈ 100 MB/min at the
	 * 144 KiB chunk), so a large file never trips the 240 frames/min drop and chat frames never
	 * compete with it. Over the budget the client is dropped, like the frame limit. */
	uploadFramesPerMinute: 720,
	maxOutboundBytes: 1024 * 1024,
	askTimeoutMs: 120_000,
	maxPendingAsks: 16,
	/** Minimum time between two connectors snapshots (spawns); the outcome is cached for it. */
	connectorsMinIntervalMs: 1000,
	/** #378: bound for waiting out an interrupted turn before a permission change may be applied. */
	interruptSafePointMs: 30_000,
	/** Minimum time between two /proc session scans (#360); the snapshot is cached for it. */
	sessionsMinIntervalMs: 2000,
	/** Messages per history page (T4 U1); Gentle Dot's HISTORY_PAGE. */
	historyPage: 100,
	/** K2-05 boot order: how long a get_history waits for a starting engine (Gentle Dot's READY_TIMEOUT_MS). */
	readyWaitMs: 60_000,
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
 * agent-turn admission (send/steer) and every verb that spawns
 * a process (agent_connect, connectors_list, agents_list). Stopping or reading
 * work (abort, agent_disconnect, every read-only query) stays allowed.
 */
const PAUSED_REFUSED = new Set(["send", "steer", "agent_connect", "hooks_install", "hooks_remove", "connectors_list", "agents_list"]);

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
		this.interruptedRecord = options.interruptedRecord; // R5
		this.onInterruptedAck = options.onInterruptedAck; // R5
		this.pendingInterrupted = undefined;
		this.pausedStore = options.pausedStore;
		// K2-05 attachments: unsent files wait OUTSIDE the engine workspace (R1-002); an accepted send moves them in.
		this.uploads = options.uploads ?? new UploadStore({ workspace: () => this.engine?.island?.workspace, staging: () => (this.engine?.island?.root ? path.join(this.engine.island.root, "uploads-staging") : undefined), log: (line) => this.log(line) });
		this.connectorsFlight = undefined; // the single in-flight snapshot promise (shared by all clients)
		this.connectorsLast = undefined; // {at, outcome: Promise-settled frame | undefined}
		this.sessionsFlight = undefined; // #360: the single in-flight scan promise (shared by all clients)
		this.sessionsLast = undefined; // #360: {at, promise} served from cache inside the min interval
		this.opts = { ...DEFAULTS, ...(options.limits ?? {}) };
		if (!Number.isSafeInteger(this.opts.historyPage) || this.opts.historyPage < 1) this.opts.historyPage = DEFAULTS.historyPage;
		this.log = options.log ?? (() => {});
		this.clients = new Set();
		// F1 (U2 re-verify): separate accounting, both removed synchronously on close/destroy.
		// `pending` holds PRE-hello connections (bounded by maxHandshakes); `auth` holds admitted
		// handshakes and is the ONLY thing maxClients counts. `clients` stays the registry of
		// every live socket (broadcast, held prompts, shutdown).
		this.pending = new Set();
		this.auth = new Set();
		this.busy = false;
		this.switching = undefined; // the single in-flight profile/role selection
		this.authFlow = undefined; // last sign-in flow seen: {flowId, accountId, method, phase}
		this.authEarly = undefined; // phase of a flow whose auth_start reply has not landed yet
		this.messageCounter = 0;
		this.historySeq = 0; // T4 U1 freshness: bumped on every message announcement (Gentle Dot's nextMessage)
		this.asks = new Map();
		// K2-05 bind by id: requestIds already seen (Gentle Dot's dedupe, bounded, oldest first out),
		// and the requests the engine may still record: the dispatched prompts (each its own request,
		// oldest first: a run records its prompt first) and the steers of the running turn, each
		// { client, requestId?, text }.
		this.seenRequests = new Set();
		this.promptRequests = [];
		this.steerRequests = [];
		// The open session's display rows, counted from the engine's message events since the
		// last idle snapshot ({file, rows, role}); undefined when events may have been missed.
		this.rowTail = undefined;
		this.server = undefined;
		this.endpoint = undefined;
		this.directory = undefined;
		this.closing = undefined;
		this.listeners = [];
		/** K2-05 boot order: the reads held while the engine starts (Gentle Dot whenReady), each with its own timer. */
		this.readyWaiters = new Set();
		/** The single engine `status` listener every held read shares (bounded, never one per call). */
		this.readyWatch = undefined;
	}

	static generateToken() {
		return generateToken();
	}

	get messageId() {
		return `m${this.messageCounter}`;
	}

	state() {
		// K2-05 U5c: `model` = the engine's own model identity (get_state), present only when it reported one.
		const model = this.engine?.status === "ready" ? this.engine.model : undefined;
		return { busy: this.busy || this.engine?.busy === true || this.switching !== undefined, status: this.engineStatus(), paused: this.paused === true, ...(model ? { model } : {}) };
	}

	/**
	 * K2-05 boot order = Gentle Dot bridge.ts deriveState: the daemon listens before its engine
	 * was launched, so a "stopped" engine that was never started reads "starting" (only an engine
	 * that was started and then stopped is really "stopped"). An engine without `launched`
	 * (tests, older shape) keeps its own status.
	 */
	engineStatus() {
		const status = this.engine?.status ?? "stopped";
		return status === "stopped" && this.engine?.launched === false ? "starting" : status;
	}

	/**
	 * Gentle Dot bridge.ts:729-747 whenReady: resolves once the engine is ready; rejects when it
	 * stops, or when READY_WAIT_MS (Gentle Dot's READY_TIMEOUT_MS, 60 s) elapses FROM THIS CALL —
	 * the timer starts here, inside the call, exactly as upstream, so two reads 30 s apart time out
	 * 30 s apart and a later read is never cut short by an earlier one's deadline.
	 * What Koda does NOT copy is one listener per call: every held read shares ONE engine `status`
	 * listener (registered by the first one), so a client repeating get_history cannot pile
	 * listeners on the engine's emitter. It keeps the per-call timing above because each caller
	 * owns its own timer; the shared listener only ever decides ready/stopped for all of them.
	 */
	whenReady() {
		if (this.engine?.status === "ready") return Promise.resolve();
		const engine = this.engine;
		if (!engine?.on || this.closing) return Promise.reject(new Error("engine is not ready"));
		// One timer per call, counted from now; the shared listener is already there or is added here.
		const promise = new Promise((resolve, reject) => {
			const waiter = { resolve, reject };
			waiter.timer = setTimeout(() => {
				this.readyWaiters.delete(waiter);
				if (this.readyWaiters.size === 0) this.unwatchReady();
				reject(new Error("the engine did not start in time"));
			}, this.opts.readyWaitMs);
			waiter.timer.unref?.();
			this.readyWaiters.add(waiter);
			this.watchReady(engine);
		});
		promise.catch(() => {});
		return promise;
	}

	/** Registers the single shared `status` listener of the held reads (no-op when it exists). */
	watchReady(engine) {
		if (this.readyWatch) return;
		const onStatus = ({ state }) => {
			if (state === "ready") this.settleReady();
			else if (state === "stopped") this.settleReady(new Error("the engine stopped"));
		};
		this.readyWatch = { engine, onStatus };
		engine.on("status", onStatus);
	}

	/** Drops the shared `status` listener once no read is waiting for it. */
	unwatchReady() {
		const watch = this.readyWatch;
		if (!watch) return;
		this.readyWatch = undefined;
		watch.engine.off("status", watch.onStatus);
	}

	/** Settles every read waiting for the engine at once: ready (no error) or the reason it never came. */
	settleReady(error) {
		const waiters = [...this.readyWaiters];
		this.readyWaiters.clear();
		this.unwatchReady();
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			if (error) waiter.reject(error);
			else waiter.resolve();
		}
	}

	/**
	 * The open chat's session files, oldest first (T4 U1, Gentle Dot bridge.ts chain()).
	 * K2-05 verifier fix: a chain file is read only when it is a regular, non-symlink,
	 * owned file directly inside the engine's private sessions dir — the same rule the
	 * runtime enforces for open sessions (isOwnedSessionFile). A planted symlink (one
	 * answered "OUTSIDE-SECRET" to the verifier) or an outside path is dropped with a
	 * log line, never read; `allowMissing` keeps a not-yet-written open session legible.
	 */
	historyChain() {
		const file = this.engine?.sessionFile;
		if (typeof file !== "string") return [];
		const owned = (p) => {
			if (this.engine.isOwnedSessionFile?.(p, true)) return true;
			this.log(`history: a chain file is not an owned session file, skipped: ${p}`);
			return false;
		};
		return [...(this.engine.previousSessions ?? []).filter(owned), ...(owned(file) ? [file] : [])];
	}

	/** One history page of the open chat; unreadable chain files are skipped with a log line. */
	historyPage(before) {
		return pageHistory(this.historyChain(), this.opts.historyPage, before, (line) => this.log(line));
	}

	/**
	 * T4 U1 freshness (K2-05 verifier fix, Gentle Dot bridge.ts:1131-1145 currentHistory):
	 * history replaces what a window shows, so it must not be older than the messages
	 * already announced — the engine writes a message to its session file right after
	 * announcing it, so one get_state round trip makes sure everything announced so far
	 * is on disk; when a message was announced DURING that round trip, the page is read
	 * again (bounded, like upstream). `get_earlier` does not do this (upstream parity).
	 */
	async currentHistory(before) {
		for (let attempt = 0; ; attempt++) {
			const seen = this.historySeq;
			await this.engine.request({ type: "get_state" });
			const page = this.historyPage(before);
			if (this.historySeq === seen || attempt >= 2) return page;
		}
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
		on(this.engine, "model", () => this.broadcastState());
		on(this.engine, "turn_cancelled", ({ reason }) => {
			// the runtime drops the cancelled turn's events: the row count is no longer known
			this.rowTail = undefined;
			this.forgetRequests();
			for (const id of [...this.asks.keys()]) this.closeAsk(id, false);
			// #378: the copy is fixed and sanitized; engine text never reaches a client.
			this.broadcast(closedToast(reason));
		});
		// T4 U1: after a rotation the open session (and its chain) changes; every
		// client gets the same chat again, now marked earlier (Gentle Dot
		// bridge.ts:1124-1129). See onEngineHistoryEvent for which events qualify.
		on(this.engine, "session_changed", (payload) => this.onEngineHistoryEvent("session_changed", payload));
		on(this.engine, "sessions_linked", (payload) => this.onEngineHistoryEvent("sessions_linked", payload));
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
		// F1 (U2 re-verify): two independent bounds. (a) PRE-hello connections are bounded HERE,
		// at connect, by maxHandshakes — the connect-time client cap was removed in the U2
		// follow-up, which left a connect burst unbounded until its handshake window closed it,
		// and a surplus connect is destroyed silently (never counted, nothing sent).
		// (b) The client cap itself counts only authenticated live clients and is evaluated in
		// onHello, AFTER the ready reply is on the wire — a probing socket (classifySession's
		// hello→ready, the island telling the daemon alive) holds a slot only for its handshake
		// window (handshakeMs, bounded) and its classification can never be refused by the cap
		// while settings and chat are connected. The pre-hello data caps still apply.
		if (this.closing) {
			socket.destroy();
			return;
		}
		if (this.pending.size >= this.opts.maxHandshakes) {
			socket.destroy();
			return;
		}
		const client = { socket, ready: false, seq: 0, pending: Buffer.alloc(0), frames: 0, windowStart: Date.now(), dead: false, uploadFrames: 0, uploadWindowStart: undefined, failedUploads: new Set() };
		this.clients.add(client);
		this.pending.add(client);
		client.handshake = setTimeout(() => this.drop(client), WIN ? Math.min(this.opts.handshakeMs, WIN_HANDSHAKE_MS) : this.opts.handshakeMs);
		socket.on("error", () => this.drop(client));
		socket.on("close", () => {
			clearTimeout(client.handshake);
			client.dead = true;
			// every accounting set is freed here too: the close event is the backstop for any
			// path the synchronous drop() could have missed (they are all idempotent deletes)
			this.clients.delete(client);
			this.pending.delete(client);
			this.auth.delete(client);
			this.uploads.dropOwner(client); // K2-05: what it never sent is removed
		});
		socket.on("data", (chunk) => this.onData(client, chunk));
	}

	drop(client) {
		client.dead = true;
		clearTimeout(client.handshake);
		// synchronous: a dropped socket frees its slots BEFORE the close event fires, so the
		// very next hello sees the room (Sets also make the later close event a no-op)
		this.clients.delete(client);
		this.pending.delete(client);
		this.auth.delete(client);
		this.uploads.dropOwner(client); // K2-05: what it never sent is removed
		client.socket.destroy();
	}

	/**
	 * Counts one frame against its per-client minute budget (K2-05: `upload` chunks have their own);
	 * false = over the budget (the caller drops the client, a ready one after a rate_limited frame).
	 */
	countFrame(client, upload) {
		const now = Date.now();
		const key = upload ? "uploadFrames" : "frames";
		const start = upload ? "uploadWindowStart" : "windowStart";
		if (now - (client[start] ?? now) >= 60_000 || client[start] === undefined) {
			client[key] = 0;
			client[start] = now;
		}
		client[key] += 1;
		return client[key] <= (upload ? this.opts.uploadFramesPerMinute : this.opts.framesPerMinute);
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
			if (!client.ready) {
				if (!this.countFrame(client, false)) return this.drop(client);
				this.onHello(client, line);
			} else {
				const decoded = P.decodeClientLine(line);
				// K2-05 attachments: an upload chunk spends the upload budget, every other frame the frame budget
				if (!this.countFrame(client, decoded.frame?.type === "upload")) {
					this.sendTo(client, P.errorFrame("rate_limited"));
					return this.drop(client);
				}
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
		// F1 (U2 re-verify): the `ready` reply goes on the wire BEFORE the cap is evaluated, and
		// the cap counts ONLY authenticated live clients (`this.auth`, filled here for admitted
		// handshakes, removed synchronously on close/destroy). The daemon's own health probe
		// (classifySession's hello→ready) reads only this first frame, so a burst of concurrent
		// probes is always classified while settings and chat are connected; pre-hello sockets
		// (bounded separately by maxHandshakes) never count here. A client refused by the cap
		// gets its ready frame and is then closed silently, like every other refusal.
		const accepted = this.auth.size < this.opts.maxClients;
		this.sendTo(client, {
			type: "ready",
			protocol: P.PROTOCOL,
			state: this.state(),
			limits: { maxFrameBytes: P.LIMITS.maxFrameBytes, maxClients: this.opts.maxClients },
			// T4 U1: one continuous chat (L3/L4/L7, Gentle Dot's features shape).
			// History reads the whole rotated chain; the conversation list is off.
			features: { history: true, conversations: false },
			// R5: the unconsumed interrupted-work record, bounded closed fields
			// (counts and time only); absent once a client acknowledged it.
			...(this.pendingInterrupted ? { interrupted: this.pendingInterrupted } : {}),
		});
		if (!accepted || client.dead) return this.drop(client);
		clearTimeout(client.handshake);
		client.ready = true;
		this.auth.add(client);
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
		// T4 U1 freshness (Gentle Dot bridge.ts nextMessage): every message announcement
		// bumps the sequence the history read compares across its get_state round trip.
		if (event?.type === "message_start" || event?.type === "message_update" || event?.type === "message_end"
			|| event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
			this.historySeq += 1;
		}
		// K2-05 bind by id (Gentle Dot bridge.ts onMessageStart): the engine starts recording a user message
		if (event?.type === "message_start") {
			// count the display row this message opens (only while the count is known for the open file)
			let row;
			if (this.rowTail && this.rowTail.file === this.engine?.sessionFile) {
				const step = nextRow(this.rowTail, event.message?.role);
				this.rowTail = { file: this.rowTail.file, ...step.tail };
				row = step.userRow;
			} else this.rowTail = undefined;
			if (event.message?.role === "user") this.onUserMessage(event.message, row);
		}
		if (event?.type === "agent_settled") this.forgetRequests();
		const out = P.translateEvent(event, this.messageId);
		if (out.busy !== undefined && out.busy !== this.busy) {
			this.busy = out.busy;
			this.broadcastState();
		}
		for (const frame of out.frames) this.broadcast(frame);
		if (out.messageDone) this.messageCounter += 1;
		if (out.ask) this.openAsk(withAskDetails(out.ask, event));
		if (out.cancelUi) this.safeSend({ type: "extension_ui_response", id: out.cancelUi, cancelled: true });
	}

	/**
	 * K2-05 F3: delivers the prompt a client typed during a rotation switch,
	 * once the switch has settled (or failed and recovered). One held prompt per
	 * client; the delivery follows the same optimistic-busy path as a normal
	 * send. No-op while a switch is still in flight or a turn runs. Several held
	 * prompts are each dispatched as their own prompt (Gentle Dot bridge.ts:404
	 * does the same: every send awaiting the switch goes on as a plain prompt);
	 * the engine runs one at a time and refuses the others, and each refusal
	 * forgets only its OWN request (K2-05 F1), so the delivered prompt keeps its
	 * sender's requestId and the refused sender gets `failed` and no requestId.
	 */
	flushHeldPrompts() {
		if (!this.engine || this.engine.sessionChange || this.state().busy) return;
		let alongside = false;
		for (const client of [...this.clients]) {
			const held = client.heldPrompt;
			if (!held) continue;
			client.heldPrompt = undefined;
			this.busy = true; // optimistic: the agent_start event confirms
			this.broadcastState();
			const request = this.expectPrompt(client, held, alongside);
			alongside = true;
			// K2-05 attachments: the held files are moved into the workspace when the prompt goes
			// (R1-001: reserved until the engine answers).
			if (held.attachments && !this.uploads.accept(client, held.attachments)) {
				this.forgetRequest(request);
				if (this.engine && this.engine.status === "ready" && this.engine.busy !== true) this.busy = false;
				this.broadcastState();
				this.sendTo(client, requestError("upload_failed", held.requestId));
				continue;
			}
			this.promptCommand(held.text, held.files, held.images).then((command) => this.engine.request(command)).then(() => {
				if (held.attachments) this.uploads.consume(client, held.attachments);
			}, () => {
				if (held.attachments) this.uploads.release(client, held.attachments);
				this.forgetRequest(request);
				// A lost ACK may already have started Pi work; the runtime owns
				// cutoff/recovery. An old rejection cannot free a new turn.
				if (this.engine && this.engine.status === "ready" && this.engine.busy !== true) this.busy = false;
				this.broadcastState();
				this.sendTo(client, requestError("failed", held.requestId));
			}).then(() => {
				if (this.engine && this.engine.status === "ready" && this.engine.busy !== true && this.busy) {
					this.busy = false;
					this.broadcastState();
				}
			});
		}
	}

	/**
	 * T4 U1 (Gentle Dot bridge.ts:1124-1129): after a rotation every connected
		 * client gets the same chat again, now marked earlier. Only a change of the
		 * OPEN session that already carries its chain qualifies:
		 * - `sessions_linked` fires when the rotator links a file; it is only
		 *   broadcast when that file IS the open one (the rotation fallback links
		 *   the fresh session right after it was created; the seed is linked while
		 *   the old session is still open and stays silent).
		 * - `session_changed` fires when the engine confirmed the open session; it
		 *   is broadcast only when that session has a linked chain, so the
		 *   fallback's window between the new session and its link never
		 *   broadcasts an empty page that would clear the island's view.
		 */
	onEngineHistoryEvent(name, payload) {
		const engine = this.engine;
		if (!engine || engine.status !== "ready" || typeof engine.sessionFile !== "string") return;
		const file = engine.sessionFile;
		if (payload?.sessionFile !== undefined && payload.sessionFile !== file) return;
		const linked = engine.chains?.[file];
		if (name === "session_changed" && !(Array.isArray(linked) && linked.length > 0)) return;
		try {
			this.broadcast(P.historyFrame(this.historyPage(undefined)));
		} catch {
			this.log("history rebroadcast not sent");
		}
	}

	// ----- K2-05 attachments ---------------------------------------------------------------------

	/**
	 * Whether the engine's current model accepts images (Gentle Dot supervisor.modelImages: Pi's
	 * `get_state` model `input`); undefined when unknown — then images are saved, not inlined.
	 */
	async modelImages() {
		try {
			const state = await this.engine.request({ type: "get_state" });
			const input = state?.data?.model?.input;
			return Array.isArray(input) ? input.includes("image") : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The engine prompt of one send (Gentle Dot bridge.ts dispatch): plain text, or — with files —
	 * composePrompt's `<attachments>` block (absolute stored paths the agent reads with its tools),
	 * the images inline only for a vision model, read back as stored (no link, same size).
	 */
	async promptCommand(text, files, images) {
		const command = { type: "prompt", message: text };
		const all = [...(images ?? [])];
		if (files?.length) {
			const composed = composePrompt(text, files, { images: await this.modelImages() });
			command.message = composed.message;
			if (composed.images) all.push(...composed.images);
		}
		if (all.length) command.images = all;
		return command;
	}

	/** One `upload` chunk: stored, refused once (later chunks of a refused upload are ignored), or finished. */
	onUpload(client, frame) {
		if (client.failedUploads.has(frame.requestId)) {
			if (frame.offset + frame.data.length < frame.size) return undefined;
			client.failedUploads.delete(frame.requestId); // the last chunk: the id is free again
			return undefined;
		}
		const out = this.uploads.receive(client, frame);
		if (!out.ok) {
			if (frame.offset + frame.data.length < frame.size) {
				client.failedUploads.add(frame.requestId);
				if (client.failedUploads.size > 16) client.failedUploads.delete(client.failedUploads.values().next().value);
			}
			return this.sendTo(client, requestError(out.code, frame.requestId));
		}
		if (out.done) {
			try {
				return this.sendTo(client, P.uploadedFrame(frame.requestId, out.file));
			} catch {
				this.uploads.discard(client, out.file.id);
				return this.sendTo(client, requestError("upload_failed", frame.requestId));
			}
		}
		return undefined;
	}

	// ----- K2-05 bind by id: which recorded prompt answers which request -----------------------

	/**
	 * Gentle Dot's alreadySeen (bridge.ts:1380), split in two (K2-05 review F1): the repeat check
	 * runs before every gate, but an id is only remembered once its request passed the daemon's
	 * transient gates (engine ready, no session switch, busy/not busy, pause) — dispatched to the
	 * engine or held for a rotation. A request those gates refused is not spent, so the client may
	 * retry it with the same id. A request the engine itself rejected stays spent (a lost ACK may
	 * already have started work; a repeat must never prompt twice).
	 */
	rememberRequest(requestId) {
		if (requestId === undefined || this.seenRequests.has(requestId)) return;
		this.seenRequests.add(requestId);
		if (this.seenRequests.size > REMEMBERED_REQUEST_IDS) this.seenRequests.delete(this.seenRequests.values().next().value);
	}

	/**
	 * The engine is idle and about to get a prompt: nothing is being written, so the open file's
	 * rows are read once here; every later row is counted from the engine's events (Pi persists a
	 * message right after announcing it, so reading the file at `message_start` would race it).
	 */
	snapshotRows() {
		const file = this.engine?.sessionFile;
		this.rowTail = typeof file === "string" ? { file, ...sessionTail(file, (line) => this.log(line)) } : undefined;
	}

	/**
	 * A prompt goes to the engine: the first recorded user message of its run is its own. A prompt
	 * dispatched to an idle engine starts a new run: nothing older can still be recorded (a prompt the
	 * engine handled without a run never settles one), so its rows are read once and it is the only
	 * pending prompt. `alongside` = dispatched right after another held prompt in the same flush
	 * (K2-05 F1): it keeps the earlier one's request and its row count.
	 */
	expectPrompt(client, frame, alongside = false) {
		if (!alongside) {
			this.promptRequests = [];
			this.snapshotRows();
		}
		const request = { client, requestId: frame.requestId, text: frame.text };
		this.promptRequests.push(request);
		return request;
	}

	expectSteer(client, frame) {
		const request = { client, requestId: frame.requestId, text: frame.text };
		this.steerRequests.push(request);
		if (this.steerRequests.length > MAX_STEER_REQUESTS) this.steerRequests.shift();
		return request;
	}

	/** The engine refused the request: it records nothing, so it can never name a record. Only that
	 * request is forgotten: any other prompt or steer still on its way keeps its own (K2-05 F1). */
	forgetRequest(request) {
		this.promptRequests = this.promptRequests.filter((r) => r !== request);
		this.steerRequests = this.steerRequests.filter((r) => r !== request);
	}

	/** The run settled (or the engine went away): whatever it did not record never will be. */
	forgetRequests() {
		this.promptRequests = [];
		this.steerRequests = [];
	}

	/**
	 * The request a recorded user message answers. Pi records the dispatched prompt first in its run
	 * and the steers by their text, in order (agent-session.js removes a consumed steer by text): the
	 * oldest pending prompt when the text is its own, else the oldest steer with that text, else the
	 * oldest pending prompt (a template expansion changes the recorded text), else the oldest pending
	 * steer (K2-05 F4: a steer's template expansion too; Pi records its queue in order) — but only
	 * while every pending steer is the same client's (K2-05 review F2): the record may be any of them,
	 * or an extension's own message, so with steers of two clients waiting it answers nobody's
	 * request rather than hand one client's requestId to another's record. Once nothing is pending, a
	 * record (an extension's own user message) answers nobody's request.
	 */
	takeRequest(text) {
		const prompt = this.promptRequests[0];
		if (prompt && prompt.text === text) return this.promptRequests.shift();
		const at = this.steerRequests.findIndex((r) => r.text === text);
		if (at >= 0) return this.steerRequests.splice(at, 1)[0];
		if (prompt) return this.promptRequests.shift();
		const steer = this.steerRequests[0];
		if (steer && this.steerRequests.every((r) => r.client === steer.client)) return this.steerRequests.shift();
		return undefined;
	}

	/**
	 * Gentle Dot bridge.ts onMessageStart: every client is told about every prompt the engine records,
	 * by the page id history gives it (`s<open file index>-<its row>`; the open file is the chain's last).
	 * The client whose request it is also gets its requestId back. A session file the history would
	 * not read (not owned) gets no frame: it could never be joined.
	 */
	onUserMessage(message, row) {
		const { text, attachments } = splitAttachments(textOf(message));
		const request = this.takeRequest(text);
		const file = this.engine?.sessionFile;
		const chain = this.historyChain();
		if (row === undefined || typeof file !== "string" || chain.at(-1) !== file) return;
		let frame;
		let own;
		try {
			const record = { id: `s${chain.length - 1}-${row}`, text, attachments };
			frame = P.userMessageFrame(record);
			if (request?.requestId !== undefined) own = P.userMessageFrame(record, request.requestId);
		} catch {
			this.log("user message not sent");
			return;
		}
		for (const client of [...this.clients]) if (client.ready) this.sendTo(client, own && client === request.client ? own : frame);
	}

	onEngineStatus(exited = false) {
		if (exited || this.engine?.status !== "ready") {
			this.forgetRequests();
			this.rowTail = undefined;
		}
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
		// F3: the rotation switch settled (or failed and recovered) — held prompts go now.
		this.flushHeldPrompts();
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
		// K2-05 U4b: the optional details travel only when present (live frame and connect replay alike)
		return {
			type: "ask",
			id: ask.id,
			kind: ask.kind,
			title: ask.title,
			options: ask.options,
			...(ask.message ? { message: ask.message } : {}),
			...(ask.placeholder ? { placeholder: ask.placeholder } : {}),
		};
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

	/**
	 * K2-05 R1-001: the resolution names the outcome ONLY to the client whose own accepted
	 * `ui_response` closed the ask (`ask_resolved{id, answered:true}`); every other client gets the
	 * plain frame, because another client's answer or the 120 s expiry closed it and an answer
	 * nobody accepted must never be shown as sent. An expiry, a cancel and an engine restart stay
	 * plain to everyone.
	 */
	closeAsk(id, answered, answeringClient) {
		const ask = this.asks.get(id);
		if (!ask) return;
		clearTimeout(ask.timer);
		this.asks.delete(id);
		for (const client of [...this.clients]) {
			if (!client.ready) continue;
			const own = answered === true && client === answeringClient;
			this.sendTo(client, own ? { type: "ask_resolved", id, answered: true } : { type: "ask_resolved", id });
		}
	}

	// ----- client commands ---------------------------------------------------------

	async handle(client, frame) {
		const reply = (f) => this.sendTo(client, f);
		// K2-05 review F6: an error answering a send/steer names it by its requestId (only to its
		// sender), so the client never has to guess which of its commands a refusal answers.
		const correlated = (frame.type === "send" || frame.type === "steer") ? frame.requestId : undefined;
		const fail = (code) => reply(requestError(code, correlated));
		// T2/F3: internal /gentle: commands are not part of the product. The fixed
		// refusal (bad_request) is deterministic and runs BEFORE every other gate
		// (paused included), and the command never reaches the engine.
		if ((frame.type === "send" || frame.type === "steer") && isBlockedInput(frame.text)) return fail("bad_request");
		// K2-05 bind by id (Gentle Dot bridge.ts:399): a repeated requestId is ignored, silently. The id
		// is remembered only once the request passed the transient gates below (review F1).
		if (correlated !== undefined && this.seenRequests.has(correlated)) return undefined;
		// T4 U1 (L3/L4/L7, Gentle Dot bridge.ts conversationsOn 476-482/677-682):
		// the island keeps ONE continuous chat, so its conversation verbs are
		// refused with this fixed error BEFORE every other gate (busy, paused
		// included) and no command ever reaches the engine.
		if (frame.type === "new_conversation") return fail("conversations_off");
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
			case "upload":
				// K2-05 attachments: not a turn (allowed while paused, like Gentle Dot's /upload)
				return this.onUpload(client, frame);
			case "upload_discard":
				this.uploads.discard(client, frame.id);
				return undefined;
			case "send": {
				// T2: blocked input was already refused above, before every gate.
				if (!ready()) return fail("unavailable");
				// K2-05 attachments (Gentle Dot bridge.ts attachedFiles): every id must be one this
				// client uploaded and has not sent; nothing reaches the engine otherwise, and the
				// refusal does not spend the requestId.
				let files;
				if (frame.attachments) {
					const found = this.uploads.resolve(client, frame.attachments);
					if (!found.ok) return fail(found.code);
					files = found.files;
				}
				// K2-05 F3 (Gentle Dot bridge.ts:404): a prompt typed while a ROTATION
				// switch is in flight is HELD — one per client, in order — and delivered
				// once the switch settles, instead of a busy bounce the user would have
				// to resend. A second prompt while one is already held is still refused
				// (Gentle Dot holds exactly one). A NON-rotation session change (a user
				// reset, new_conversation) is never held: it answers busy as always.
				if (this.engine?.sessionChange?.switching === true) {
					if (client.heldPrompt) return fail("busy");
					this.rememberRequest(frame.requestId);
					client.heldPrompt = { text: frame.text, images: frame.images, requestId: frame.requestId, attachments: frame.attachments, files };
					return undefined;
				}
				if (this.state().busy) return fail("busy");
				// R1-002/R1-001: only an accepted send moves the files in; they stay reserved until it settles.
				if (frame.attachments && !this.uploads.accept(client, frame.attachments)) return fail("upload_failed");
				this.rememberRequest(frame.requestId);
				this.busy = true; // optimistic: the agent_start event confirms
				this.broadcastState();
				const request = this.expectPrompt(client, frame);
				try {
					// The response only acknowledges the prompt; completion is agent_settled.
					await this.engine.request(await this.promptCommand(frame.text, files, frame.images));
					// K2-05: sent — the files stay for the agent, no other message can send them
					if (frame.attachments) this.uploads.consume(client, frame.attachments);
				} catch {
					if (frame.attachments) this.uploads.release(client, frame.attachments);
					this.forgetRequest(request);
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
				{
					this.rememberRequest(frame.requestId);
					const request = this.expectSteer(client, frame);
					return run(() => this.engine.request({ type: "steer", message: frame.text }).catch((error) => {
						this.forgetRequest(request);
						throw error;
					}));
				}
			case "abort":
				if (!ready()) return fail("unavailable");
				return run(() => this.engine.request({ type: "abort" }));
			case "get_history": {
				// T4 U1 + K2-05 boot order (Gentle Dot bridge.ts:622-624 whenReady): a client asks for
				// history as soon as it connects, often while the engine starts; the read waits for the
				// engine instead of being refused. An engine that stops (or does not start within
				// readyWaitMs) answers unavailable, never an empty page that would clear what the
				// island already shows. The read carries Gentle Dot's freshness round trip (currentHistory).
				if (!ready()) {
					try {
						await this.whenReady();
					} catch {
						return fail("unavailable");
					}
				}
				if (!ready() || typeof this.engine?.sessionFile !== "string") return fail("unavailable");
				try {
					return reply(P.historyFrame(await this.currentHistory(undefined)));
				} catch {
					this.log("command get_history failed");
					return fail("failed");
				}
			}
			case "get_earlier": {
				if (!ready() || typeof this.engine?.sessionFile !== "string") return fail("unavailable");
				try {
					return reply(P.earlierFrame(frame.before, this.historyPage(frame.before)));
				} catch {
					this.log("command get_earlier failed");
					return fail("failed");
				}
			}
			case "ui_response": {
				const ask = this.asks.get(frame.id);
				if (!ask) return fail("unknown_ask");
				const response = P.buildUiResponse(ask, frame);
				if (!response) return fail("bad_request");
				if (!this.safeSend(response)) return fail("unavailable");
				this.closeAsk(frame.id, true, client);
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
			this.settleReady(new Error("the server closed"));
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

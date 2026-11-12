"use strict";

// U3 server tests: fake engine/accounts/profiles + a real Unix socket in a temp dir.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { IslandServer } = require("../src/server.cjs");
const P = require("../src/protocol.cjs");

const TOKEN = "t".repeat(43);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(5);
	}
	assert.ok(fn(), "waitFor timed out");
}

class FakeEngine extends EventEmitter {
	constructor() {
		super();
		this.status = "ready";
		this.requests = [];
		this.sent = [];
		this.hold = false;
		// #378 fake turn lifecycle: agent_start events open a turn, interruptTurn
		// closes it; stuckAfterInterrupt models a cutoff whose safe point never
		// arrives (busy stays true).
		this.turnActive = false;
		this.interruptedWith = undefined;
		this.stuckAfterInterrupt = false;
		// K2-05 F3: a session switch in flight (a rotation); the server holds a
		// prompt typed during it instead of answering busy.
		this.sessionChange = undefined;
		// K2-05 T4 U1: the rotated chain of the open session (real AgentEngine shape.
		this.sessionFile = undefined;
		this.chains = {};
		// K2-05 T4 U1 verifier fix: a private sessions dir + the ownership rule the real
		// runtime enforces (isOwnedSessionFile), so history reads refuse planted files.
		this.sessionsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-fake-engine-")));
		// K2-05 attachments: the island's own engine workspace (runtime.cjs island.workspace)
		this.island = { workspace: path.join(this.sessionsDir, "workspace") };
		this.pendingPersist = undefined; // freshness test hook: a reply persisted only when a get_state arrives
	this.onGetState = undefined; // freshness test hook: an announcement during the round trip
}
	/** The server's busy guard reads this: true only while a switch is in flight. */
	get busy() {
		return this.sessionChange !== undefined;
	}
	/** The earlier session files of the open chat, oldest first (runtime.cjs shape). */
	get previousSessions() {
		return this.chains[this.sessionFile] ?? [];
	}
	/** The ownership rule the real runtime enforces for session files (verifier fix 4). */
	isOwnedSessionFile(file, allowMissing = false) {
		if (typeof file !== "string") return false;
		const resolved = path.resolve(file);
		if (!resolved.startsWith(`${this.sessionsDir}${path.sep}`)) return false;
		let stats;
		try {
			stats = fs.lstatSync(resolved);
		} catch (error) {
			return allowMissing && error?.code === "ENOENT" && path.dirname(resolved) === this.sessionsDir;
		}
		return !stats.isSymbolicLink() && stats.isFile();
	}
	/** Intercepts fake agent records to track the turn lifecycle without registering a listener. */
	emit(type, payload) {
		if (type === "event") {
			if (payload?.type === "agent_start") this.turnActive = true;
			if (payload?.type === "agent_settled") this.turnActive = false;
		}
		return super.emit(type, payload);
	}
async request(command) {
		this.requests.push(command);
		// Freshness test hooks (verifier fix 2): a pending reply is persisted only when a
		// get_state round trip reaches it — a plain file read would miss it — and
		// onGetState fires an announcement DURING the round trip so the retry re-reads.
		if (command.type === "get_state") {
				// K2-05 attachments: the engine's model, as Pi's get_state reports it (input: text/image)
				if (this.stateData) return { type: "response", success: true, data: this.stateData };
				if (this.pendingPersist) {
						const flush = this.pendingPersist;
						this.pendingPersist = undefined;
						flush();
				}
				if (this.onGetState) {
						const announce = this.onGetState;
						this.onGetState = undefined;
						announce();
				}
		}
		// K2-05 bind by id: an engine that rejects the prompt/steer (nothing is recorded).
		if (this.reject?.includes(command.type)) throw new Error(`${command.type} rejected`);
		if (command.type === "prompt") {
			this.turnActive = true;
			if (this.hold) await new Promise(() => {});
		}
		return { type: "response", success: true };
	}
	interruptTurn(reason) {
		this.interruptedWith = reason;
		if (this.turnActive !== true) return false;
		this.turnActive = false;
		this.emit("turn_cancelled", { reason });
		if (this.stuckAfterInterrupt !== true) this.emit("event", { type: "agent_settled" });
		return true;
	}
	send(record) {
		this.sent.push(record);
	}
}
class FakeAccounts extends EventEmitter {
	listAccounts() {
		return [{ accountId: "main", label: "Main", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-SECRETMARK" }];
	}
	async providers() {
		return [{ id: "p", name: "P", methods: ["api_key"], configured: true, baseUrl: "http://sk-SECRETMARK" }];
	}
	async models() {
		return [{ provider: "p", id: "m", name: "M", input: ["text"], contextWindow: 10, headers: { a: "sk-SECRETMARK" } }];
	}
	async startLogin() {
		return { flowId: "flow-1" };
	}
	async createAccount(input) {
		this.created = input;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId: input.accountId ?? "new-1", label: input.label, provider: input.provider, authMethod: "none", configured: false, apiKey: "sk-SECRETMARK" };
	}
	async removeAccount(accountId) {
		this.removed = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, removed: true };
	}
	async logout(accountId) {
		this.loggedOut = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, label: "Main", provider: "p", authMethod: "none", configured: false };
	}
	async status(accountId) {
		this.statusOf = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, label: "Main", provider: "p", authMethod: "api_key", configured: true, token: "sk-SECRETMARK" };
	}
	async reply(flowId, body) {
		this.replied = { flowId, ...body };
		return { ok: true };
	}
	async cancel(flowId) {
		this.cancelled = flowId;
		return { ok: true };
	}
}
class FakeProfiles {
	constructor() {
		this.selected = [];
	}
	list() {
		return { profiles: [{ id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low", env: { K: "sk-SECRETMARK" } }], active: "work" };
	}
	roles() {
		return [{ role: "main", profileIds: ["work"] }];
	}
	async select(id) {
		this.selected.push(id);
	}
	async selectForRole(role) {
		this.selected.push(`role:${role}`);
	}
	async save(input) {
		this.saved = input;
		if (this.failWith) throw new Error(this.failWith);
		return input;
	}
	async remove(id) {
		this.removedId = id;
		if (this.failWith) throw new Error(this.failWith);
		return { id, removed: true };
	}
	async deactivate() {
		this.deactivations = (this.deactivations ?? 0) + 1;
		if (this.failWith) throw new Error(this.failWith);
		return { ok: true };
	}
}

function tmpRuntime(t) {
	const base = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return path.join(base, "run");
}

async function setup(t, { limits = {}, token = TOKEN, paused = false, pausedStore, connectors, agents } = {}) {
	const engine = new FakeEngine();
	const accounts = new FakeAccounts();
	const profiles = new FakeProfiles();
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token, engine, accounts, profiles, limits, paused, ...(pausedStore ? { pausedStore } : {}), ...(connectors ? { connectors } : {}), ...(agents ? { agents } : {}) });
	t.after(() => fs.rmSync(engine.sessionsDir, { recursive: true, force: true }));
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, engine, accounts, profiles, endpoint, runtimeDir };
}

/** Raw client that parses LF frames. */
function connect(endpoint) {
	const socket = net.connect(endpoint);
	const c = { socket, frames: [], closed: false, buf: "" };
	socket.setEncoding("utf8");
	socket.on("data", (d) => {
		c.buf += d;
		let i;
		while ((i = c.buf.indexOf("\n")) !== -1) {
			c.frames.push(JSON.parse(c.buf.slice(0, i)));
			c.buf = c.buf.slice(i + 1);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => (c.closed = true));
	c.send = (f) => socket.write(`${JSON.stringify(f)}\n`);
	c.wait = (pred, ms) => waitFor(() => c.frames.some(pred), ms).then(() => c.frames.find(pred));
	return c;
}
async function login(t, endpoint) {
	const c = connect(endpoint);
	t.after(() => c.socket.destroy());
	await new Promise((r) => c.socket.once("connect", r));
	c.send({ type: "hello", protocol: P.PROTOCOL, token: TOKEN });
	await c.wait((f) => f.type === "ready");
	return c;
}
const hello = (over = {}) => ({ type: "hello", protocol: P.PROTOCOL, token: TOKEN, ...over });

test("handshake succeeds: ready with seq 1, then monotonic seq", async (t) => {
	const { endpoint } = await setup(t);
	const c = await login(t, endpoint);
	assert.equal(c.frames[0].type, "ready");
	assert.equal(c.frames[0].seq, 1);
	assert.equal(c.frames[0].protocol, "island-agent/1");
	c.send({ type: "status" });
	c.send({ type: "status" });
	await waitFor(() => c.frames.length === 3);
	assert.deepEqual(c.frames.map((f) => f.seq), [1, 2, 3]);
});

test("handshake: bad token, bad protocol, non-hello and garbage close silently", async (t) => {
	const { endpoint } = await setup(t);
	for (const first of [hello({ token: "x".repeat(43) }), hello({ protocol: "island-agent/2" }), { type: "status" }, "garbage"]) {
		const c = connect(endpoint);
		await new Promise((r) => c.socket.once("connect", r));
		c.socket.write(typeof first === "string" ? `${first}\n` : `${JSON.stringify(first)}\n`);
		await waitFor(() => c.closed);
		assert.equal(c.frames.length, 0, "no detail sent");
	}
});

test("handshake timeout closes an idle connection", async (t) => {
	const { endpoint } = await setup(t, { limits: { handshakeMs: 80 } });
	const c = connect(endpoint);
	await waitFor(() => c.closed);
	assert.equal(c.frames.length, 0);
});

test("oversized frames close the connection (hello and post-handshake)", async (t) => {
	const { endpoint } = await setup(t);
	const a = connect(endpoint);
	await new Promise((r) => a.socket.once("connect", r));
	a.socket.write(`{"type":"hello","token":"${"a".repeat(P.LIMITS.maxHelloBytes + 10)}"}\n`);
	await waitFor(() => a.closed);

	const c = await login(t, endpoint);
	c.socket.write(`${JSON.stringify({ type: "send", text: "x".repeat(P.LIMITS.maxFrameBytes + 10) })}\n`);
	await waitFor(() => c.closed);
	// Unterminated flood is bounded too.
	const d = await login(t, endpoint);
	d.socket.write("y".repeat(P.LIMITS.maxFrameBytes * 5));
	await waitFor(() => d.closed);
});

test("rate limit closes a flooding client", async (t) => {
	const { endpoint } = await setup(t, { limits: { framesPerMinute: 5 } });
	const c = await login(t, endpoint);
	for (let i = 0; i < 10; i++) c.send({ type: "status" });
	await waitFor(() => c.closed);
});

test("max clients is enforced at hello AFTER the ready reply: the probe is always classified (F1)", async (t) => {
	const { endpoint } = await setup(t, { limits: { maxClients: 1 } });
	await login(t, endpoint);
	const second = connect(endpoint);
	await new Promise((r) => second.socket.once("connect", r));
	// The cap counts ONLY authenticated live clients. The `ready` reply goes on the wire BEFORE
	// the cap is evaluated, so the daemon's own health probe (classifySession's hello→ready,
	// which reads only the first frame) is never refused by the cap even when it is full — a
	// connect-time refusal used to make `status` report stale/endpoint_refused while the
	// settings window and the chat were both connected. The refused client is closed silently
	// right after its ready frame, like every other refusal.
	second.send(hello());
	await second.wait((f) => f.type === "ready");
	await waitFor(() => second.closed);
	assert.equal(second.frames.length, 1, "ready first (the probe's classification), then a silent close");
});

// F1 (re-verify): the island's settings window and the chat both stay connected; chat
// reconnects must be accepted, and a 5th concurrent client is still refused — but its ready
// frame always leaves first, so a probe sharing the burst is never left unclassified.
test("the client cap is 4: a third and a fourth client are accepted, a 5th is refused (F1)", async (t) => {
	const { endpoint } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const c = await login(t, endpoint); // a reconnecting chat client, slots were full
	assert.equal(c.frames[0].type, "ready");
	const d = await login(t, endpoint);
	assert.equal(d.frames[0].type, "ready");
	const fifth = connect(endpoint);
	await new Promise((r) => fifth.socket.once("connect", r));
	fifth.send(hello());
	await fifth.wait((f) => f.type === "ready");
	await waitFor(() => fifth.closed);
	assert.equal(fifth.frames.length, 1, "ready first, then the silent cap refusal");
	// The four accepted clients keep working.
	for (const client of [a, b]) {
		client.send({ type: "status" });
		await client.wait((f) => f.type === "agent_state");
	}
});

// L1 (U2 re-verify): the cap counts ONLY authenticated live clients — pre-hello sockets never
// count against it — so a burst of concurrent health probes (classifySession's hello→ready,
// run by `abito-island-daemon status` and by the island) is entirely answered ready while the
// settings window and the chat are connected: no probe can ever report the daemon
// stale/endpoint_refused. Each probe reads at least its ready frame; a probe refused by the
// cap simply gets ready and is closed right after, which classifySession reads as healthy.
test("settings + chat + a burst of 8 concurrent probes: every probe reads a ready frame", async (t) => {
	const { endpoint } = await setup(t);
	const settings = await login(t, endpoint);
	const chat = await login(t, endpoint);
	const probes = [];
	await Promise.all([...Array(8)].map(async (_, i) => {
		const c = connect(endpoint);
		t.after(() => c.socket.destroy());
		await new Promise((r) => c.socket.once("connect", r));
		c.send(hello());
		probes[i] = c;
	}));
	for (const probe of probes) await probe.wait((f) => f.type === "ready");
	assert.deepEqual(probes.map((probe) => probe.frames[0].type), Array(8).fill("ready"),
		"every concurrent probe is classified: its first frame is ready");
	// and both authenticated clients keep working
	settings.send({ type: "status" });
	chat.send({ type: "status" });
	await settings.wait((f) => f.type === "agent_state");
	await chat.wait((f) => f.type === "agent_state");
});

// L1 (U2 re-verify): pre-hello connections have their OWN bound (maxHandshakes; each is also
// bounded by the handshake timeout). A surplus connect is destroyed silently at connect —
// never counted anywhere — and the connected authenticated clients are unaffected.
test("20 pre-hello sockets: the 17th+ are refused at connect, authenticated clients are unaffected", async (t) => {
	const { endpoint, server } = await setup(t, { limits: { maxHandshakes: 16 } });
	const settings = await login(t, endpoint);
	const chat = await login(t, endpoint);
	const sockets = [];
	for (let i = 0; i < 20; i += 1) {
		const socket = net.connect(endpoint);
		t.after(() => socket.destroy());
		await new Promise((r) => socket.once("connect", r));
		sockets.push(socket);
	}
	// the first 16 hold their pre-hello slot; the remaining 4 were destroyed at connect
	await waitFor(() => server.pending.size === 16, 5000);
	assert.equal(server.pending.size, 16, "the 16th connect was the last one admitted pre-hello");
	await waitFor(() => sockets.filter((s) => !s.destroyed && !s.readableEnded && s.readyState !== "closed").length <= 16, 5000);
	// and the two authenticated clients still work
	for (const c of [settings, chat]) {
		c.send({ type: "status" });
		await c.wait((f) => f.type === "agent_state");
	}
});

// L1 (U2 re-verify): a dropped socket frees its slots SYNCHRONOUSLY — drop() deletes from
// every accounting set before the close event ever fires, so the very next hello sees the room.
test("a dropped client frees its slots immediately", async (t) => {
	const { endpoint, server } = await setup(t, { limits: { maxClients: 1 } });
	const first = await login(t, endpoint);
	assert.equal(first.frames[0].type, "ready");
	assert.equal(server.auth.size, 1, "the admitted handshake counts");
	// Server-side drop (the same path every refusal, timeout and overflow uses):
	server.drop([...server.auth][0]);
	assert.equal(server.auth.size, 0, "the authenticated slot is free before any close event");
	assert.equal(server.clients.size, 0, "the socket registry is free too");
	const next = await login(t, endpoint);
	assert.equal(next.frames[0].type, "ready", "the very next hello is admitted into the freed slot");
	next.send({ type: "status" });
	await next.wait((f) => f.type === "agent_state");
});

const WIN = process.platform === "win32";
test("socket is 0600 inside a 0700 private directory; path guard", { skip: WIN && "Unix socket mechanism; Windows twin: «Windows: the endpoint is a named pipe…» below" }, async (t) => {
	const { endpoint, runtimeDir } = await setup(t);
	assert.equal(fs.lstatSync(endpoint).mode & 0o7777, 0o600);
	assert.ok(fs.lstatSync(endpoint).isSocket());
	assert.equal(fs.lstatSync(path.dirname(endpoint)).mode & 0o7777, 0o700);
	assert.equal(fs.lstatSync(runtimeDir).mode & 0o7777, 0o700);
	const long = new IslandServer({ runtimeDir: path.join(tmpRuntime(t), "x".repeat(120)), token: TOKEN, engine: new FakeEngine() });
	await assert.rejects(long.start());
});
// Windows twins (W1): no socket file, no private directory, no leftovers: the endpoint is a named pipe whose exact shape the Rust client checks
// (winpolicy::pipe_endpoint_ok), the token gate is the access control, and a pipe vanishes with its server.
test("Windows: the endpoint is a named pipe abito-<32 hex>, nothing is created on disk, and it disappears with the server", { skip: !WIN && "Windows only; Unix twin: «socket is 0600 inside a 0700 private directory»" }, async (t) => {
	const { server, endpoint, runtimeDir } = await setup(t);
	assert.match(endpoint, /^\\\\\.\\pipe\\abito-[0-9a-f]{32}$/);
	const entries = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir) : [];
	assert.deepEqual(entries.filter((n) => n.startsWith("p-")), [], "no socket directory on Windows (the runtime root itself may exist)");
	const c = await login(t, endpoint);
	assert.ok(c);
	await server.close();
	await assert.rejects(new Promise((resolve, reject) => { const s = require("node:net").connect(endpoint); s.once("connect", () => { s.destroy(); resolve(); }); s.once("error", reject); }));
});

test("a non-private runtime directory is refused", { skip: WIN && "no runtime directory on Windows (named pipe); twin: «Windows: the endpoint is a named pipe…»" }, async (t) => {
	const dir = tmpRuntime(t);
	fs.mkdirSync(dir, { mode: 0o755 });
	fs.chmodSync(dir, 0o755);
	await assert.rejects(new IslandServer({ runtimeDir: dir, token: TOKEN, engine: new FakeEngine() }).start());
});

test("stale socket of a dead server is cleaned; a live one is kept", { skip: WIN && "pipes vanish with their server: no stale endpoint exists; twin: «Windows: the endpoint is a named pipe…»" }, async (t) => {
	const runtimeDir = tmpRuntime(t);
	fs.mkdirSync(runtimeDir, { mode: 0o700 });
	const stale = path.join(runtimeDir, "p-abc123");
	fs.mkdirSync(stale, { mode: 0o700 });
	// A server process killed with SIGKILL leaves its socket file behind.
	const { spawnSync } = require("node:child_process");
	spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path.join(stale, "s"))}, () => process.kill(process.pid, "SIGKILL"))`], { timeout: 10000 });
	assert.ok(fs.lstatSync(path.join(stale, "s")).isSocket(), "stale socket left behind");

	const live = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	const { endpoint } = await live.start();
	t.after(() => live.close());
	assert.ok(!fs.existsSync(stale), "stale dir removed");
	// A second server must not touch the first one's live endpoint.
	const other = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	await other.start();
	assert.ok(fs.existsSync(endpoint));
	await other.close();
	assert.ok(fs.existsSync(endpoint));
});

test("prompt flow: busy rejected, deltas translated, settle frees the turn", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "send", text: "hello" });
	await c.wait((f) => f.type === "agent_state" && f.busy === true);
	assert.deepEqual(engine.requests[0], { type: "prompt", message: "hello" });
	c.send({ type: "send", text: "again" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1);

	engine.emit("event", { type: "agent_start" });
	engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });
	engine.emit("event", { type: "message_end", message: { role: "assistant" } });
	const d = await c.wait((f) => f.type === "message_delta");
	const done = await c.wait((f) => f.type === "message_done");
	assert.equal(d.text, "Hi");
	assert.equal(d.messageId, done.messageId);
	// The prompt response does not free the turn; agent_settled does.
	assert.equal(c.frames.filter((f) => f.type === "agent_state").at(-1).busy, true);
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	c.send({ type: "send", text: "next" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
});

test("the user's own prompt text reaches the engine untouched (T2)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	// T2: the user's own prompt text is never white-labelled — their words (their
	// Raspberry Pi, their "gentle shell" mention, their abito) reach the engine
	// exactly as typed. presentText is assistant/harness output only.
	const raw = "cuéntame de Raspberry Pi, de mi abito y de Gentle Shell";
	c.send({ type: "send", text: raw });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt" && r.message === raw));
	assert.equal(engine.requests.filter((r) => r.type === "prompt").at(-1).message, raw);
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === true);
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
});

test("internal /gentle: commands are refused with a fixed error and never reach the engine (T2)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	for (const text of ["/gentle:memory-save", "  /gentle:x", "/GENTLE:jobs"]) {
		c.send({ type: "send", text });
		await c.wait((f) => f.type === "error" && f.code === "bad_request");
	}
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 0, "no /gentle: command reached the engine");
	// Mid-turn steering refuses it too.
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "steer", text: "/gentle:memory-search" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
	assert.equal(engine.requests.filter((r) => r.type === "steer").length, 0, "no /gentle: steer reached the engine");
	// Normal steering text still flows: the busy turn accepts it.
	c.send({ type: "steer", text: "hola" });
	await waitFor(() => engine.requests.some((r) => r.type === "steer" && r.message === "hola"));
});

// F3 (verifier): the /gentle: refusal runs before the pause gate, so the
// answer is always bad_request — never `paused`, and nothing ever queues it.
test("a /gentle: command is bad_request even while paused (F3)", async (t) => {
	const store = { paused: false, writes: [], get() { return store.paused; }, set(value) { store.writes.push(value); store.paused = value; } };
	const { endpoint, engine } = await setup(t, { pausedStore: store });
	const c = await login(t, endpoint);
	c.send({ type: "set_paused", paused: true });
	await c.wait((f) => f.type === "agent_state" && f.paused === true);
	c.send({ type: "send", text: "/gentle:memory-save" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
	c.send({ type: "steer", text: "/gentle:memory-search" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
	// A normal send while paused is still refused with `paused`, not bad_request.
	c.send({ type: "send", text: "hola" });
	await c.wait((f) => f.type === "error" && f.code === "paused");
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 0, "nothing reached the engine");
});

test("steer needs a busy turn; abort keeps working; new_conversation is refused conversations_off (T4 U1)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "steer", text: "x" });
	await c.wait((f) => f.type === "error" && f.code === "not_busy");
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "steer", text: "left" });
	c.send({ type: "abort" });
	await waitFor(() => engine.requests.some((r) => r.type === "abort") && engine.requests.some((r) => r.type === "steer"));
	// T4 U1: conversations are always off — the refusal is fixed, busy included.
	c.send({ type: "new_conversation" });
	await c.wait((f) => f.type === "error" && f.code === "conversations_off");
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	c.send({ type: "new_conversation" });
	await c.wait((f) => f.type === "error" && f.code === "conversations_off");
	assert.equal(engine.requests.some((r) => r.type === "new_session"), false, "no conversation reset ever reaches the engine");
});

test("event allowlist on the wire: unknown dropped, tool args and secret markers never leak", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "something_new", data: "sk-SECRETMARK" });
	engine.emit("event", { type: "tool_execution_start", toolName: "read", args: { path: "/x", content: "sk-SECRETMARK" } });
	engine.emit("event", { type: "tool_execution_update", toolName: "read", partialResult: "sk-SECRETMARK" });
	engine.emit("event", { type: "tool_execution_end", toolName: "read", result: "sk-SECRETMARK", isError: false });
	engine.emit("event", { type: "turn_end", message: "sk-SECRETMARK" });
	await c.wait((f) => f.type === "activity" && f.state === "done");
	c.send({ type: "accounts_list" });
	c.send({ type: "providers_list" });
	c.send({ type: "models_list" });
	c.send({ type: "profiles_list" });
	await c.wait((f) => f.type === "profiles");
	await c.wait((f) => f.type === "models");
	assert.ok(!JSON.stringify(c.frames).includes("SECRETMARK"));
	assert.deepEqual(c.frames.filter((f) => f.type === "activity").map((f) => f.state), ["running", "done"]);
	assert.ok(!c.frames.some((f) => f.type === "something_new" || f.type === "turn_end"));
});

test("profile and role selection go to the store; refused while busy", async (t) => {
	const { server, endpoint, engine, profiles } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	await waitFor(() => c.frames.some((f) => f.type === "profiles"));
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").pop()?.busy === false && !server.switching);
	c.send({ type: "role_select", role: "main" });
	await waitFor(() => profiles.selected.length === 2);
	assert.deepEqual(profiles.selected, ["work", "role:main"]);
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "profile_select", id: "work" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(profiles.selected.length, 2);
});

test("ask round-trip: select answered; invalid and unknown answers rejected", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
	const ask = await c.wait((f) => f.type === "ask");
	assert.deepEqual({ id: ask.id, kind: ask.kind, title: ask.title, options: ask.options }, { id: "u1", kind: "select", title: "Pick", options: ["a", "b"] });
	c.send({ type: "ui_response", id: "u1", value: "zzz" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
	c.send({ type: "ui_response", id: "nope", value: "a" });
	await c.wait((f) => f.type === "error" && f.code === "unknown_ask");
	assert.equal(engine.sent.length, 0);
	c.send({ type: "ui_response", id: "u1", value: "b" });
	await c.wait((f) => f.type === "ask_resolved");
	assert.deepEqual(engine.sent, [{ type: "extension_ui_response", id: "u1", value: "b" }]);
	// A late duplicate is unknown.
	c.send({ type: "ui_response", id: "u1", value: "b" });
	await waitFor(() => c.frames.filter((f) => f.code === "unknown_ask").length === 2);
});

// K2-05 U4b: the island's ask card shows what the user approves (Gentle Dot Ask.message /
// Ask.placeholder). Additive optional fields, white-labelled like the title, bounded, on the
// live frame AND on the replay a late client gets; the user's typed answer travels verbatim.
test("ask carries the confirm message and the input placeholder, white-labelled, bounded and replayed; the typed answer is never rewritten", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "c1", method: "confirm", title: "¿Borrar?", message: "Gentle Shell va a borrar notas.md via engram" });
	const confirm = await c.wait((f) => f.type === "ask" && f.id === "c1");
	assert.equal(confirm.message, "Koda va a borrar notas.md via memory");
	assert.equal("placeholder" in confirm, false, "a confirm has no placeholder");
	engine.emit("event", { type: "extension_ui_request", id: "i1", method: "input", title: "Nombre", placeholder: "tu pi-coding-agent favorito" });
	const input = await c.wait((f) => f.type === "ask" && f.id === "i1");
	assert.equal(input.placeholder, "tu assistant favorito");
	assert.equal("message" in input, false, "no message was asked");
	// bounded: a huge message is clipped (2000 UTF-16 units), a non-string is dropped, controls never travel
	engine.emit("event", { type: "extension_ui_request", id: "c2", method: "confirm", title: "t", message: `a\u0000b${"x".repeat(5000)}` });
	const big = await c.wait((f) => f.type === "ask" && f.id === "c2");
	assert.equal(big.message.length, 2000);
	assert.ok(big.message.startsWith("abx"));
	engine.emit("event", { type: "extension_ui_request", id: "i2", method: "input", title: "t", placeholder: 7 });
	const odd = await c.wait((f) => f.type === "ask" && f.id === "i2");
	assert.equal("placeholder" in odd, false);
	// a late client gets the same fields in the replay
	const late = await login(t, endpoint);
	await waitFor(() => late.frames.filter((f) => f.type === "ask").length === 4);
	assert.equal(late.frames.find((f) => f.type === "ask" && f.id === "c1").message, "Koda va a borrar notas.md via memory");
	assert.equal(late.frames.find((f) => f.type === "ask" && f.id === "i1").placeholder, "tu assistant favorito");
	// the user's own typed answer reaches the engine verbatim (never white-labelled)
	c.send({ type: "ui_response", id: "i1", value: "mi Raspberry Pi con engram y Gentle Shell" });
	await c.wait((f) => f.type === "ask_resolved" && f.id === "i1");
	assert.deepEqual(engine.sent.at(-1), { type: "extension_ui_response", id: "i1", value: "mi Raspberry Pi con engram y Gentle Shell" });
});

test("ask timeout cancels toward the agent; editor dialogs are cancelled at once", async (t) => {
	const { endpoint, engine } = await setup(t, { limits: { askTimeoutMs: 60 } });
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u2", method: "confirm", title: "Sure?" });
	await c.wait((f) => f.type === "ask");
	await c.wait((f) => f.type === "ask_resolved");
	assert.deepEqual(engine.sent.at(-1), { type: "extension_ui_response", id: "u2", cancelled: true });
	engine.emit("event", { type: "extension_ui_request", id: "u3", method: "editor", title: "E" });
	assert.deepEqual(engine.sent.at(-1), { type: "extension_ui_response", id: "u3", cancelled: true });
});

test("engine restart: agent_state restarting, no half answer replayed, asks closed", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "agent_start" });
	engine.emit("event", { type: "extension_ui_request", id: "u9", method: "input", title: "N" });
	await c.wait((f) => f.type === "ask");
	engine.status = "restarting";
	engine.emit("exit", { code: 1 });
	engine.emit("status", { state: "restarting" });
	const st = await c.wait((f) => f.type === "agent_state" && f.status === "restarting");
	assert.equal(st.busy, false);
	await c.wait((f) => f.type === "ask_resolved");
	c.send({ type: "send", text: "x" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	// A late client sees no replay of the old turn or the closed ask.
	const late = await login(t, endpoint).catch(() => undefined);
	assert.ok(!late || !late.frames.some((f) => f.type === "ask" || f.type === "message_delta"));
});

test("auth: passthrough events, replies go to the manager only", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const c = await login(t, endpoint);
	accounts.emit("auth_prompt", { flowId: "f", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true, leak: "sk-SECRETMARK" });
	accounts.emit("auth_event", { flowId: "f", kind: "url", url: "http://auth.example", leak: "sk-SECRETMARK" });
	accounts.emit("auth_done", { flowId: "f", accountId: "main", ok: true, leak: "sk-SECRETMARK" });
	await c.wait((f) => f.type === "auth_done");
	c.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await c.wait((f) => f.type === "auth_started" && f.flowId === "flow-1");
	c.send({ type: "auth_reply", flowId: "flow-1", promptId: "p1", value: "typed-secret-value" });
	c.send({ type: "auth_cancel", flowId: "flow-1" });
	await waitFor(() => accounts.replied && accounts.cancelled);
	assert.equal(accounts.replied.value, "typed-secret-value");
	const wire = JSON.stringify(c.frames);
	assert.ok(!wire.includes("SECRETMARK") && !wire.includes("typed-secret-value"));
});

test("a slow client is dropped; the others keep working", async (t) => {
	const { server, endpoint, engine } = await setup(t, { limits: { maxOutboundBytes: 64 * 1024 } });
	const slow = await login(t, endpoint);
	slow.socket.pause();
	const fast = await login(t, endpoint);
	const chunk = "z".repeat(15000);
	for (let i = 0; i < 400 && server.clients.size === 2; i++) {
		engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
		await sleep(2);
	}
	await waitFor(() => server.clients.size === 1, 5000); // server side: the slow client was dropped
	assert.ok(fast.frames.length > 1);
	assert.equal(fast.closed, false);
});

test("malformed post-handshake frames get a generic error, not a close", async (t) => {
	const { endpoint } = await setup(t);
	const c = await login(t, endpoint);
	c.socket.write("{broken\n");
	c.send({ type: "nonsense", stack: "x" });
	await waitFor(() => c.frames.filter((f) => f.type === "error").length === 2);
	assert.ok(c.frames.filter((f) => f.type === "error").every((f) => f.code === "bad_request" && Object.keys(f).sort().join() === "code,seq,type"));
	assert.equal(c.closed, false);
});

test("shutdown removes socket and directory, drops clients, leaves no timers", async (t) => {
	const { server, engine, endpoint, runtimeDir } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u7", method: "input", title: "N" });
	await c.wait((f) => f.type === "ask");
	await server.close();
	await waitFor(() => c.closed);
	assert.ok(!fs.existsSync(endpoint));
	assert.deepEqual(fs.readdirSync(runtimeDir), []);
	assert.equal(engine.listenerCount("event"), 0);
	assert.equal(server.asks.size, 0);
	await server.close(); // idempotent
});

test("tokens: generated tokens are random and long; short ones refused", () => {
	assert.notEqual(IslandServer.generateToken(), IslandServer.generateToken());
	assert.ok(IslandServer.generateToken().length >= 43);
	assert.throws(() => new IslandServer({ runtimeDir: "/tmp/x", token: "short", engine: new FakeEngine() }));
});

test("selection is serialized: send/steer/second select are busy while a switch is in flight", async (t) => {
	const { endpoint, engine, profiles } = await setup(t);
	let release;
	profiles.select = async (id) => {
		profiles.selected.push(id);
		await new Promise((r) => (release = r));
	};
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	const state = await c.wait((f) => f.type === "agent_state" && f.busy);
	assert.equal(state.busy, true);
	c.send({ type: "send", text: "hi" });
	c.send({ type: "steer", text: "hi" });
	c.send({ type: "profile_select", id: "other" });
	c.send({ type: "role_select", role: "main" });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length >= 3);
	assert.equal(engine.requests.filter((r) => r.type === "prompt" || r.type === "steer").length, 0);
	assert.deepEqual(profiles.selected, ["work"]);
	// A stray engine event cannot clear the switch guard.
	engine.emit("event", { type: "agent_settled" });
	c.send({ type: "send", text: "again" });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length >= 4);
	release();
	await c.wait((f) => f.type === "agent_state" && f.busy === false);
	c.send({ type: "send", text: "ok" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
});

test("a failed selection releases the switch guard", async (t) => {
	const { endpoint, profiles } = await setup(t);
	profiles.select = async () => {
		throw new Error("boom");
	};
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	c.send({ type: "status" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").length >= 2);
	assert.equal(c.frames.filter((f) => f.type === "agent_state").pop().busy, false);
});

// ----- v0.2: provider settings frames ----------------------------------------

const types = (c, type) => c.frames.filter((f) => f.type === type);
const errorCodes = (c) => types(c, "error").map((f) => f.code);
const nextError = async (c, from) => (await c.wait((f) => f.type === "error" && c.frames.indexOf(f) >= from)).code;

// ----- K2-05 T3: a prompt during a rotation is held, not bounced (F3) --------

test("a prompt typed during a rotation switch is held and sent when the switch ends (F3)", async (t) => {
	const { engine, endpoint } = await setup(t);
	const c = await login(t, endpoint);
	// A rotation switch is in flight (the daemon's rotator owns it).
	engine.sessionChange = { switching: true };
	c.send({ type: "send", text: "durante" });
	await sleep(100);
	assert.equal(errorCodes(c).includes("busy"), false, "the prompt is held, not bounced with busy");
	assert.deepEqual(engine.requests, [], "and nothing reaches the engine while the switch runs");
	// When the switch finishes (or fails) the engine says so (a status event,
	// exactly what changeSession emits), and the held prompt is sent, once.
	engine.sessionChange = undefined;
	engine.emit("status", {});
	await waitFor(() => engine.requests.some((r) => r.type === "prompt" && r.message === "durante"));
	await sleep(50);
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1, "exactly one held prompt is delivered");
});

test("at most one held prompt per client; a busy turn is still refused (F3)", async (t) => {
	const { server, engine, endpoint } = await setup(t);
	const c = await login(t, endpoint);
	engine.sessionChange = { switching: true };
	c.send({ type: "send", text: "primero" });
	await sleep(50);
	c.send({ type: "send", text: "segundo" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(engine.requests.length, 0, "the second prompt was not held");
	engine.sessionChange = undefined;
	engine.emit("status", {});
	await waitFor(() => engine.requests.some((r) => r.type === "prompt" && r.message === "primero"));
	await sleep(50);
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1, "only the held prompt was sent");
	// A busy TURN (no switch in flight) keeps the classic busy refusal: steer owns it.
	engine.emit("event", { type: "agent_start" });
	await waitFor(() => server.state().busy === true);
	c.send({ type: "send", text: "en turno" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1, "nothing extra was sent during the turn");
});

test("a prompt during a NON-rotation session change (a user reset) is still busy, never held (F3 regression)", async (t) => {
	const { engine, endpoint } = await setup(t);
	const c = await login(t, endpoint);
	// A user-driven new_session reset is in flight (new_conversation): no hold.
	engine.sessionChange = { switching: false };
	c.send({ type: "send", text: "denied" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(engine.requests.length, 0, "nothing was held or sent for a non-rotation change");
	engine.sessionChange = undefined;
	engine.emit("status", {});
	await sleep(50);
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 0, "no held prompt materialises after the reset");
});

test("account_create: replies account to the caller and broadcasts accounts to every client; extras never reach the store", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "account_create", provider: "p", label: "Mine", accountId: "mine", extra: "x" });
	const account = await a.wait((f) => f.type === "account");
	assert.deepEqual(account.account, { accountId: "mine", label: "Mine", provider: "p", authMethod: "none", configured: false });
	assert.deepEqual(accounts.created, { provider: "p", label: "Mine", accountId: "mine" });
	await a.wait((f) => f.type === "accounts");
	await b.wait((f) => f.type === "accounts");
	assert.equal(types(b, "account").length, 0, "the account reply is not broadcast");
	a.send({ type: "account_create", provider: "p", label: "No id" });
	await waitFor(() => types(a, "account").length === 2);
	assert.deepEqual(accounts.created, { provider: "p", label: "No id" });
});

test("account_remove/logout/status: broadcast or reply, with generic busy|failed errors", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "account_remove", accountId: "main" });
	await b.wait((f) => f.type === "accounts");
	assert.equal(accounts.removed, "main");
	a.send({ type: "account_logout", accountId: "main" });
	await waitFor(() => types(b, "accounts").length === 2);
	assert.equal(accounts.loggedOut, "main");
	a.send({ type: "account_status", accountId: "main" });
	const status = await a.wait((f) => f.type === "account");
	assert.deepEqual(status.account, { accountId: "main", label: "Main", provider: "p", authMethod: "api_key", configured: true });
	assert.equal(types(b, "account").length, 0);
	// in use by a profile -> failed; sign-in in progress -> busy; nothing else leaks
	accounts.failWith = "Account in use by a profile";
	let from = a.frames.length;
	a.send({ type: "account_remove", accountId: "main" });
	assert.equal(await nextError(a, from), "failed");
	accounts.failWith = "Authentication busy: a sign-in is in progress";
	from = a.frames.length;
	a.send({ type: "account_logout", accountId: "main" });
	assert.equal(await nextError(a, from), "busy");
	assert.ok(!JSON.stringify(a.frames).includes("in use by a profile"));
	assert.equal(types(b, "accounts").length, 2, "failures broadcast nothing");
});

test("account_logout of the active profile's account deactivates it first; busy leaves the credential untouched", async (t) => {
	const { endpoint, profiles, accounts, engine } = await setup(t);
	const a = await login(t, endpoint);
	a.send({ type: "account_logout", accountId: "main" });
	await a.wait((f) => f.type === "accounts");
	assert.equal(accounts.loggedOut, "main");
	assert.equal(profiles.deactivations, 1);
	// non-active account: active profile untouched
	accounts.loggedOut = undefined;
	a.send({ type: "account_logout", accountId: "other" });
	await waitFor(() => accounts.loggedOut === "other");
	assert.equal(profiles.deactivations, 1);
	// busy: #378 the in-flight turn yields first; the logout then proceeds
	accounts.loggedOut = undefined;
	const accountsBefore = types(a, "accounts").length;
	engine.emit("event", { type: "agent_start" });
	a.send({ type: "account_logout", accountId: "main" });
	// A FRESH accounts frame proves the logout ran after the interrupt (a stale one would race it).
	await waitFor(() => types(a, "accounts").length === accountsBefore + 1);
	assert.equal(engine.interruptedWith, "access_revoked");
	assert.equal(accounts.loggedOut, "main");
	assert.ok(a.frames.some((f) => f.type === "toast" && f.message === "Se revocó el acceso: se interrumpió el turno del agente."), "a closed event explains the interruption");
});

test("account_logout while busy keeps the old guarantee when no safe point is reached (#378)", async (t) => {
	const store = makePausedStore();
	const { engine, accounts, profiles, endpoint } = await setup(t, { pausedStore: store, limits: { interruptSafePointMs: 80 } });
	const a = await login(t, endpoint);
	engine.hold = true;
	a.send({ type: "send", text: "long turn" });
	await a.wait((f) => f.type === "agent_state" && f.busy === true);
	engine.stuckAfterInterrupt = true; // the cutoff never reaches a safe point
	const from = a.frames.length;
	a.send({ type: "account_logout", accountId: "main" });
	assert.equal(await nextError(a, from), "busy");
	assert.equal(accounts.loggedOut, undefined, "the credential is untouched on the timeout path");
	assert.equal(profiles.deactivations, undefined, "the active profile is untouched on the timeout path");
});

test("profile_save / profile_remove broadcast profiles; validation errors are generic failed", async (t) => {
	const { endpoint, profiles } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const frame = { type: "profile_save", id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low" };
	a.send({ ...frame, junk: 1 });
	await b.wait((f) => f.type === "profiles");
	assert.deepEqual(profiles.saved, { id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low" });
	a.send({ type: "profile_remove", id: "work" });
	await waitFor(() => types(b, "profiles").length === 2);
	assert.equal(profiles.removedId, "work");
	profiles.failWith = "Unknown account FAKE-INTERNAL";
	const from = a.frames.length;
	a.send(frame);
	assert.equal(await nextError(a, from), "failed");
	assert.ok(!JSON.stringify(a.frames).includes("FAKE-INTERNAL"));
	assert.equal(types(b, "profiles").length, 2);
});

test("profile_deactivate: guarded like profile_select, broadcasts profiles and agent_state", async (t) => {
	const { endpoint, profiles, engine, server } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "profile_deactivate" });
	await b.wait((f) => f.type === "profiles");
	assert.equal(profiles.deactivations, 1);
	await waitFor(() => types(a, "agent_state").length >= 2);
	// during a turn
	engine.emit("event", { type: "agent_start" });
	const from = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, from), "busy");
	assert.equal(profiles.deactivations, 1);
	// store refusal (engine busy inside the store) maps to busy, other failures to failed
	engine.emit("event", { type: "agent_settled" });
	profiles.failWith = "Engine busy: finish or abort the current turn first";
	let n = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, n), "busy");
	profiles.failWith = "Could not deactivate the profile";
	await waitFor(() => !server.switching);
	n = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, n), "failed");
});

test("profile_deactivate during a switch is busy; a deactivate in flight blocks send and select", async (t) => {
	const { endpoint, profiles, server } = await setup(t);
	const c = await login(t, endpoint);
	let release;
	profiles.select = async (id) => {
		profiles.selected.push(id);
		await new Promise((r) => (release = r));
	};
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	c.send({ type: "profile_deactivate" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(profiles.deactivations ?? 0, 0);
	release();
	await waitFor(() => !server.switching);
	// now a slow deactivate blocks others
	let free;
	profiles.deactivate = async () => {
		profiles.deactivations = (profiles.deactivations ?? 0) + 1;
		await new Promise((r) => (free = r));
	};
	c.send({ type: "profile_deactivate" });
	await waitFor(() => profiles.deactivations === 1);
	assert.equal(server.state().busy, true);
	const before = c.frames.length;
	c.send({ type: "send", text: "hi" });
	c.send({ type: "profile_select", id: "other" });
	await waitFor(() => c.frames.slice(before).filter((f) => f.type === "error" && f.code === "busy").length === 2);
	free();
	await waitFor(() => !server.switching);
});

test("auth_state: null, then phases starting -> prompt -> progress -> done; a late client recovers the flow", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const ask = async (c) => {
		const from = c.frames.length;
		c.send({ type: "auth_state" });
		await waitFor(() => c.frames.slice(from).some((f) => f.type === "auth_state"));
		return c.frames.slice(from).find((f) => f.type === "auth_state").flow;
	};
	assert.equal(await ask(a), null);
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	assert.deepEqual(await ask(a), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "starting" });
	accounts.emit("auth_prompt", { flowId: "flow-1", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true });
	await a.wait((f) => f.type === "auth_prompt");
	assert.equal((await ask(a)).phase, "prompt");
	accounts.emit("auth_event", { flowId: "flow-1", kind: "info", message: "working" });
	await a.wait((f) => f.type === "auth_event");
	const late = await login(t, endpoint);
	assert.deepEqual(await ask(late), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "progress" });
	accounts.emit("auth_done", { flowId: "flow-1", accountId: "main", ok: true });
	await a.wait((f) => f.type === "auth_done");
	assert.deepEqual(await ask(late), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "done" });
	// auth_start and auth_done frames are unchanged: no method on the wire outside auth_state
	assert.ok(!("method" in a.frames.find((f) => f.type === "auth_started")));
	assert.ok(!("method" in a.frames.find((f) => f.type === "auth_done")));
	// a rejected start (flow already running) does not replace the tracked flow
	accounts.startLogin = async () => {
		throw new Error("Authentication busy");
	};
	a.send({ type: "auth_start", accountId: "main", method: "oauth" });
	await a.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal((await ask(a)).method, "api_key");
});

test("auth events that arrive before auth_start resolves are not lost", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	accounts.startLogin = async () => {
		accounts.emit("auth_prompt", { flowId: "flow-9", promptId: "p1", accountId: "main", kind: "secret", message: "k", secret: true });
		return { flowId: "flow-9" };
	};
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	a.send({ type: "auth_state" });
	const state = await a.wait((f) => f.type === "auth_state");
	assert.deepEqual(state.flow, { flowId: "flow-9", accountId: "main", method: "api_key", phase: "prompt" });
});

test("new frames answer unavailable without the managers", async (t) => {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);
	for (const f of [
		{ type: "account_create", provider: "p", label: "L" },
		{ type: "account_remove", accountId: "a" },
		{ type: "account_logout", accountId: "a" },
		{ type: "account_status", accountId: "a" },
		{ type: "profile_save", id: "w", label: "W", role: "r", accountId: "a", provider: "p", modelId: "m" },
		{ type: "profile_remove", id: "w" },
		{ type: "profile_deactivate" },
		{ type: "auth_state" },
	]) c.send(f);
	await waitFor(() => errorCodes(c).length === 8);
	assert.deepEqual([...new Set(errorCodes(c))], ["unavailable"]);
});

test("wire-wide secret scan: accounts/profiles/auth frames carry no key, baseUrl, headers or env", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const typed = "sk-TYPED-BY-USER-9999";
	a.send({ type: "accounts_list" });
	a.send({ type: "profiles_list" });
	a.send({ type: "providers_list" });
	a.send({ type: "models_list" });
	a.send({ type: "account_create", provider: "p", label: "Mine" });
	a.send({ type: "account_status", accountId: "main" });
	a.send({ type: "account_logout", accountId: "main" });
	a.send({ type: "profile_save", id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m" });
	a.send({ type: "profile_deactivate" });
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	accounts.emit("auth_prompt", { flowId: "flow-1", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true, apiKey: "sk-SECRETMARK" });
	a.send({ type: "auth_reply", flowId: "flow-1", promptId: "p1", value: typed });
	a.send({ type: "auth_state" });
	await waitFor(() => accounts.replied && types(a, "auth_state").length === 1 && types(a, "models").length === 1);
	accounts.emit("auth_done", { flowId: "flow-1", accountId: "main", ok: true, account: { accountId: "main", label: "M", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-SECRETMARK" } });
	await a.wait((f) => f.type === "auth_done");
	assert.equal(accounts.replied.value, typed, "the secret reached the account manager");
	const wire = JSON.stringify(a.frames);
	for (const marker of ["sk-", "SECRETMARK", "TYPED-BY-USER", "baseUrl", "headers", "apiKey", "\"env\"", "\"token\"", "\"key\""]) {
		assert.ok(!wire.includes(marker), `wire contains ${marker}`);
	}
});

test("real AccountManager + fake helper: account_create -> accounts frame end to end (no secrets)", async (t) => {
	const { AccountManager, helperEnv } = require("../src/auth.cjs");
	const root = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-real-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const accountsRoot = path.join(root, "accounts");
	const manager = new AccountManager({
		accountsRoot,
		helper: {
			command: process.execPath,
			args: [path.join(__dirname, "fixtures", "fake-auth.cjs"), "--accounts-root", accountsRoot],
			env: helperEnv(process.env, { home: root, tmp: root }),
		},
	});
	t.after(() => manager.close());
	const server = new IslandServer({ runtimeDir: tmpRuntime(t), token: TOKEN, engine: new FakeEngine(), accounts: manager, profiles: new FakeProfiles() });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);
	c.send({ type: "account_create", provider: "openai", label: "Work OpenAI" });
	const reply = await c.wait((f) => f.type === "account");
	assert.deepEqual(reply.account, { accountId: "work-openai", label: "Work OpenAI", provider: "openai", authMethod: "none", configured: false });
	const listing = await c.wait((f) => f.type === "accounts");
	assert.deepEqual(listing.accounts.map((x) => x.accountId), ["work-openai"]);
	c.send({ type: "account_status", accountId: "work-openai" });
	await waitFor(() => types(c, "account").length === 2);
	c.send({ type: "account_remove", accountId: "work-openai" });
	await waitFor(() => types(c, "accounts").length === 2);
	assert.deepEqual(types(c, "accounts")[1].accounts, []);
});

// ----- settings frames (V2 hotkey) -------------------------------------------------

class FakeSettings {
	constructor(hotkey = null) {
		this.hotkey = hotkey;
		this.calls = [];
	}
	get() {
		return { hotkey: this.hotkey };
	}
	setHotkey(value) {
		this.calls.push(value);
		if (this.failWith) {
			const error = new Error(this.failWith.message);
			error.name = this.failWith.name;
			throw error;
		}
		this.hotkey = value === null ? null : String(value).toUpperCase();
		return { hotkey: this.hotkey, changed: true };
	}
}

async function setupSettings(t, settings) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), ...(settings ? { settings } : {}) });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("settings_get replies settings{hotkey} to the caller only; null when unset", async (t) => {
	const { endpoint } = await setupSettings(t, new FakeSettings());
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "settings_get" });
	const frame = await a.wait((f) => f.type === "settings");
	assert.equal(frame.hotkey, null);
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "settings"), false);
	const { endpoint: e2 } = await setupSettings(t, new FakeSettings("Ctrl+Alt+Space"));
	const c = await login(t, e2);
	c.send({ type: "settings_get" });
	assert.equal((await c.wait((f) => f.type === "settings")).hotkey, "Ctrl+Alt+Space");
});

test("settings_set persists and broadcasts settings to every client; null clears", async (t) => {
	const settings = new FakeSettings();
	const { endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "settings_set", hotkey: "ctrl+alt+space" });
	const fa = await a.wait((f) => f.type === "settings");
	const fb = await b.wait((f) => f.type === "settings");
	assert.equal(fa.hotkey, "CTRL+ALT+SPACE");
	assert.equal(fb.hotkey, "CTRL+ALT+SPACE");
	assert.deepEqual(settings.calls, ["ctrl+alt+space"]);
	assert.equal(a.frames.filter((f) => f.type === "settings").length, 1, "caller gets exactly one frame");
	b.send({ type: "settings_set", hotkey: null });
	await a.wait((f) => f.type === "settings" && f.hotkey === null);
	await b.wait((f) => f.type === "settings" && f.hotkey === null);
	assert.deepEqual(settings.calls, ["ctrl+alt+space", null]);
});

test("settings_set: invalid hotkey -> bad_request, other failure -> failed, nothing broadcast", async (t) => {
	const settings = new FakeSettings();
	const { endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	settings.failWith = { name: "ConfigError", message: "invalid config: hotkey" };
	a.send({ type: "settings_set", hotkey: "Space" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "bad_request");
	settings.failWith = { name: "Error", message: "EACCES /secret/path" };
	a.send({ type: "settings_set", hotkey: "Ctrl+A" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 2);
	const errors = a.frames.filter((f) => f.type === "error");
	assert.deepEqual(errors.map((f) => f.code), ["bad_request", "failed"]);
	assert.ok(!JSON.stringify(a.frames).includes("secret"));
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "settings"), false);
	// Malformed frames never reach the dependency.
	const before = settings.calls.length;
	a.send({ type: "settings_set", hotkey: 5 });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 3);
	assert.equal(settings.calls.length, before);
});

test("settings frames without a settings dependency -> unavailable", async (t) => {
	const { endpoint } = await setupSettings(t, undefined);
	const a = await login(t, endpoint);
	a.send({ type: "settings_get" });
	a.send({ type: "settings_set", hotkey: "Ctrl+Alt+Space" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 2);
	assert.deepEqual(a.frames.filter((f) => f.type === "error").map((f) => f.code), ["unavailable", "unavailable"]);
});

test("broadcastSettings pushes the current settings to all clients", async (t) => {
	const settings = new FakeSettings("Ctrl+Alt+Space");
	const { server, endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	server.broadcastSettings();
	assert.equal((await a.wait((f) => f.type === "settings")).hotkey, "Ctrl+Alt+Space");
});

// ----- connectors_list / connectors (V4) ------------------------------------------

const GOLDEN = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "connectors", `${name}.json`), "utf8"));

class FakeConnectors {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? { catalog: GOLDEN("catalog").entries, connectors: GOLDEN("status").connectors };
	}
	async snapshot() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupConnectors(t, connectors, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), connectors, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("connectors_list replies the sanitized connectors frame to the caller only", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	const frame = await a.wait((f) => f.type === "connectors");
	assert.equal(frame.schema, "abito-connectors/view/1");
	assert.deepEqual(frame.catalog, GOLDEN("catalog").entries);
	assert.deepEqual(frame.connectors, GOLDEN("status").connectors);
	assert.equal(typeof frame.seq, "number");
	await sleep(60);
	assert.equal(b.frames.some((f) => f.type === "connectors"), false);
});

test("connectors_list: wire never carries secret-looking data even if the dependency returns it", async (t) => {
	const data = { catalog: GOLDEN("catalog").entries.map((e) => ({ ...e, url: "SECRETMARK", env: { K: "SECRETMARK" } })), connectors: GOLDEN("status").connectors.map((c) => ({ ...c, token: "SECRETMARK", capability: "SECRETMARK", status: { ...c.status, ref: "SECRETMARK" } })) };
	const { endpoint } = await setupConnectors(t, new FakeConnectors({ data }));
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	const frame = await a.wait((f) => f.type === "connectors");
	assert.ok(!JSON.stringify(frame).includes("SECRETMARK"));
	assert.deepEqual(frame.connectors, GOLDEN("status").connectors);
});

test("connectors_list without a dependency -> unavailable; a failing dependency -> generic failed", async (t) => {
	const none = await setupConnectors(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupConnectors(t, new FakeConnectors({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "connectors_list" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|home/));
});

test("connectors_list: invalid dependency data -> failed (rebuilt strictly)", async (t) => {
	const { endpoint } = await setupConnectors(t, new FakeConnectors({ data: { catalog: [], connectors: [{ id: 1 }] } }));
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "failed");
});

test("connectors_list single-flight: N concurrent requests from 2 clients -> exactly 1 snapshot", async (t) => {
	const dep = new FakeConnectors({ delay: 150 });
	const { endpoint } = await setupConnectors(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	for (let i = 0; i < 5; i++) a.send({ type: "connectors_list" });
	for (let i = 0; i < 4; i++) b.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 5 && b.frames.filter((f) => f.type === "connectors").length === 4);
	assert.equal(dep.calls, 1);
});

test("connectors_list min interval: cached for the window (success and failure), then a new spawn", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep, { connectorsMinIntervalMs: 250 });
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	await a.wait((f) => f.type === "connectors");
	a.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 2);
	assert.equal(dep.calls, 1, "second request served from cache");
	await sleep(300);
	a.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 3);
	assert.equal(dep.calls, 2);

	const bad = new FakeConnectors({ fail: true });
	const f = await setupConnectors(t, bad, { connectorsMinIntervalMs: 250 });
	const c = await login(t, f.endpoint);
	c.send({ type: "connectors_list" });
	c.send({ type: "connectors_list" });
	await waitFor(() => c.frames.filter((x) => x.type === "error").length === 2);
	assert.equal(bad.calls, 1, "a failure is not retried inside the window");
	assert.deepEqual(c.frames.filter((x) => x.type === "error").map((x) => x.code), ["failed", "failed"]);
});

test("connectors_list counts toward the rate limit", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep, { framesPerMinute: 4 });
	const a = await login(t, endpoint);
	for (let i = 0; i < 10; i++) a.send({ type: "connectors_list" });
	await waitFor(() => a.closed);
	assert.equal(dep.calls, 1);
});

test("R3: connectors_list caps what is emitted: 128 realistic -> frame, 256 -> generic failed", async (t) => {
	const c = GOLDEN("status").connectors[0];
	const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...c, id: `c${i}` }));
	const ok = await setupConnectors(t, new FakeConnectors({ data: { catalog: GOLDEN("catalog").entries, connectors: mk(128) } }));
	const a = await login(t, ok.endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "connectors")).connectors.length, 128);
	const big = await setupConnectors(t, new FakeConnectors({ data: { catalog: GOLDEN("catalog").entries, connectors: mk(256) } }));
	const b = await login(t, big.endpoint);
	b.send({ type: "connectors_list" });
	assert.equal((await b.wait((f) => f.type === "error")).code, "failed");
	assert.equal(b.frames.some((f) => f.type === "connectors"), false);
});

// ----- V5: local OpenAI-compatible endpoint frames ----------------------------------------

const LOCAL_URL = "http://127.0.0.1:11434/v1";
function withLocal(accounts) {
	accounts.localCalls = [];
	accounts.createLocalAccount = async (input) => {
		accounts.localCalls.push(["create", input]);
		if (accounts.failWith) throw new Error(accounts.failWith);
		return { accountId: input.accountId ?? "ollama", label: input.label, provider: "local-ollama", authMethod: "api_key", configured: true, local: true, baseUrl: LOCAL_URL, kind: "local", models: ["m"] };
	};
	accounts.setLocalEndpoint = async (input) => {
		accounts.localCalls.push(["set", input]);
		if (accounts.failWith) throw new Error(accounts.failWith);
		return { accountId: input.accountId, label: "L", provider: "local-ollama", authMethod: "api_key", configured: true, local: true, baseUrl: LOCAL_URL };
	};
	return accounts;
}

test("local_account_create replies account + broadcasts accounts; no endpoint on any frame", async (t) => {
	const { endpoint, accounts } = await setup(t);
	withLocal(accounts);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "local_account_create", label: "Ollama", baseUrl: LOCAL_URL, modelIds: ["qwen2.5-coder:7b"] });
	const reply = await a.wait((f) => f.type === "account");
	assert.equal(reply.account.local, true);
	assert.deepEqual(accounts.localCalls[0], ["create", { label: "Ollama", baseUrl: LOCAL_URL, modelIds: ["qwen2.5-coder:7b"] }]);
	await b.wait((f) => f.type === "accounts");
	await a.wait((f) => f.type === "accounts");
	for (const c of [a, b]) {
		const wire = JSON.stringify(c.frames);
		for (const banned of ["11434", "127.0.0.1", "baseUrl", "abito-local-endpoint", "qwen2.5"]) assert.equal(wire.includes(banned), false, banned);
	}
	assert.equal(b.frames.some((f) => f.type === "account"), false, "reply goes to the caller only");
});

test("local frames: invalid shape/URL is bad_request; manager failure is failed; nothing leaks", async (t) => {
	const { endpoint, accounts } = await setup(t);
	withLocal(accounts);
	const c = await login(t, endpoint);
	for (const bad of [
		{ type: "local_account_create", label: "x", baseUrl: "http://10.0.0.5/v1", modelIds: ["m"] },
		{ type: "local_account_create", label: "x", baseUrl: LOCAL_URL, modelIds: [] },
		{ type: "local_endpoint_set", accountId: "ollama", baseUrl: "https://evil.com/v1", modelIds: ["m"] },
	]) c.send(bad);
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "bad_request").length === 3);
	assert.equal(accounts.localCalls.length, 0);
	accounts.failWith = "Account is not a local endpoint 11434";
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	const err = await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(JSON.stringify(c.frames).includes("11434"), false);
});

test("local_endpoint_set: ok replies account; busy while its account backs the ACTIVE profile and a turn runs", async (t) => {
	const { endpoint, accounts, server } = await setup(t); // profiles: active "work" backed by account "main"
	withLocal(accounts);
	const c = await login(t, endpoint);
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "account");
	await c.wait((f) => f.type === "accounts");
	assert.equal(accounts.localCalls.length, 1);
	server.busy = true; // a turn is running
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(accounts.localCalls.length, 1, "refused before touching the store");
	// A different account (not backing the active profile) is unaffected by a running turn.
	c.send({ type: "local_endpoint_set", accountId: "other", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await waitFor(() => accounts.localCalls.length === 2);
	// A selection in flight also refuses.
	server.busy = false;
	server.switching = new Promise(() => {});
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length === 2);
	server.switching = undefined;
});

test("local_endpoint_set never touches the live agent files (profiles untouched)", async (t) => {
	const { endpoint, accounts, profiles } = await setup(t);
	withLocal(accounts);
	const c = await login(t, endpoint);
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "account");
	assert.deepEqual(profiles.selected, []);
	assert.equal(profiles.deactivations, undefined);
});

// ----- agents_list / agent_connect / agent_disconnect / agents (H2b) -----------------

class FakeAgents extends EventEmitter {
	constructor(over = {}) {
		super();
		this.calls = [];
		this.delay = over.delay ?? 0;
		this.busy = false;
		this.fail = over.fail;
		this.state = "not_connected";
	}
	entries(state = this.state, extra = {}) {
		return [
			{ id: "claude-code", name: "Claude Code", state, backup: false, detail: null, ...extra },
			{ id: "codex", name: "Codex", state: "not_connected", backup: false, detail: null },
			{ id: "opencode", name: "OpenCode", state: "unavailable", backup: false, detail: null },
		];
	}
	async list() {
		this.calls.push(["list"]);
		return this.entries();
	}
	async connect(id, hash) {
		this.calls.push(["connect", id, hash]);
		if (this.busy) throw Object.assign(new Error("agents busy"), { code: "busy" });
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK stderr text");
		this.busy = true;
		this.emit("change", this.entries("working"));
		if (this.delay) await sleep(this.delay);
		this.busy = false;
		this.state = "connected";
		return this.entries("connected", { backup: true });
	}
	async disconnect(id) {
		this.calls.push(["disconnect", id]);
		this.state = "not_connected";
		return this.entries("not_connected");
	}
}
async function setupAgents(t, agents, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), agents, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("agents_list replies to the caller only; agent_connect broadcasts working then the result to ALL clients", async (t) => {
	const dep = new FakeAgents({ delay: 80 });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "agents_list" });
	const listed = await a.wait((f) => f.type === "agents");
	assert.equal(listed.agents.length, 3);
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "agents"), false);
	const hash = "ab".repeat(32);
	a.send({ type: "agent_connect", agentId: "claude-code", plan_hash: hash });
	for (const c of [a, b]) {
		await c.wait((f) => f.type === "agents" && f.agents[0].state === "working");
		await c.wait((f) => f.type === "agents" && f.agents[0].state === "connected" && f.agents[0].backup === true);
	}
	assert.deepEqual(dep.calls.find((c) => c[0] === "connect"), ["connect", "claude-code", hash]);
	b.send({ type: "agent_disconnect", agentId: "claude-code" });
	for (const c of [a, b]) await c.wait((f) => f.type === "agents" && f.agents[0].state === "not_connected" && c.frames.length > 0 && f.seq > 3);
});

test("agent_connect while an operation runs -> error busy", async (t) => {
	const dep = new FakeAgents({ delay: 200 });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "agent_connect", agentId: "claude-code" });
	await b.wait((f) => f.type === "agents" && f.agents[0].state === "working");
	b.send({ type: "agent_connect", agentId: "codex" });
	assert.equal((await b.wait((f) => f.type === "error")).code, "busy");
	await a.wait((f) => f.type === "agents" && f.agents[0].state === "connected");
});

test("agents without a dependency -> unavailable; invalid frames -> bad_request", async (t) => {
	const { endpoint } = await setupAgents(t, undefined);
	const a = await login(t, endpoint);
	for (const frame of [{ type: "agents_list" }, { type: "agent_connect", agentId: "codex" }, { type: "agent_disconnect", agentId: "codex" }]) a.send(frame);
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 3);
	assert.ok(a.frames.filter((f) => f.type === "error").every((f) => f.code === "unavailable"));
	a.send({ type: "agent_connect", agentId: "nope" });
	assert.equal((await a.wait((f) => f.type === "error" && f.code === "bad_request")).code, "bad_request");
});

test("agents: a failing dependency -> generic failed; no path, secret or stderr on the wire", async (t) => {
	const dep = new FakeAgents({ fail: true });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	a.send({ type: "agent_connect", agentId: "codex" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "failed");
	await sleep(30);
	assert.doesNotMatch(JSON.stringify(a.frames), /SECRETMARK|\/home\/secret|stderr text|FAKE-INTERNAL/);
});

test("agents frames count toward the per-client rate limit", async (t) => {
	const { endpoint } = await setupAgents(t, new FakeAgents(), { framesPerMinute: 4 });
	const a = await login(t, endpoint);
	for (let i = 0; i < 6; i++) a.send({ type: "agents_list" });
	await a.wait((f) => f.type === "error" && f.code === "rate_limited");
});

// ----- mcp_import_preview (#381) ------------------------------------------------

class FakeMcpImport {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? {
			files: [{ source: "cursor", status: "ok" }],
			servers: [{ source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready" }],
			truncated: false,
		};
	}
	async preview() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupMcpImport(t, mcpImport) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), mcpImport });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("mcp_import_preview without a dependency -> unavailable; a failing dependency -> generic failed", async (t) => {
	const none = await setupMcpImport(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "mcp_import_preview" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupMcpImport(t, new FakeMcpImport({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "mcp_import_preview" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|\/home/));
});

test("mcp_import_preview replies the sanitized preview frame to the caller only", async (t) => {
	const dep = new FakeMcpImport();
	const { endpoint } = await setupMcpImport(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "mcp_import_preview" });
	await waitFor(() => a.frames.some((f) => f.type === "mcp_import"));
	assert.equal(dep.calls, 1);
	const frame = a.frames.find((f) => f.type === "mcp_import");
	assert.equal(frame.schema, "abito-mcp-import/preview/1");
	assert.deepEqual(frame.files, [{ source: "cursor", status: "ok" }]);
	assert.deepEqual(frame.servers, [{ source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready" }]);
	assert.equal(frame.truncated, false);
	assert.ok(!b.frames.some((f) => f.type === "mcp_import"), "not broadcast");
	// invalid dependency data -> failed (rebuilt strictly)
	const bad = await setupMcpImport(t, new FakeMcpImport({ data: { files: [], servers: [{ id: 1 }], truncated: false } }));
	const c = await login(t, bad.endpoint);
	c.send({ type: "mcp_import_preview" });
	assert.equal((await c.wait((f) => f.type === "error")).code, "failed");
});

// ----- sessions_list (#360, F046/F049) ------------------------------------------

class FakeSessions {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? { sessions: [{ id: "s-0123abcd", kind: "pi", cwd: "mi-proyecto", state: "sleeping", origin: "herdr" }], truncated: false };
	}
	async snapshot() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupSessions(t, sessions, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), sessions, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("sessions_list replies the closed sessions frame to the caller only", async (t) => {
	const dep = new FakeSessions();
	const { endpoint } = await setupSessions(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "sessions_list" });
	const frame = await a.wait((f) => f.type === "sessions");
	assert.equal(frame.schema, "abito-sessions/view/1");
	assert.deepEqual(frame.sessions, dep.data.sessions);
	assert.equal(frame.truncated, false);
	await sleep(60);
	assert.ok(!b.frames.some((f) => f.type === "sessions"), "not broadcast");
});

test("sessions_list without a dependency -> unavailable; a failing dependency -> generic failed; the wire never carries secrets", async (t) => {
	const none = await setupSessions(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "sessions_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupSessions(t, new FakeSessions({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "sessions_list" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	await sleep(30);
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|\/home/));

	// invalid dependency data -> failed (rebuilt strictly)
	const bad = await setupSessions(t, new FakeSessions({ data: { sessions: [{ id: "x", kind: "bash" }], truncated: false } }));
	const c = await login(t, bad.endpoint);
	c.send({ type: "sessions_list" });
	assert.equal((await c.wait((f) => f.type === "error")).code, "failed");
});

test("sessions_list serves the snapshot from the cache inside the min interval", async (t) => {
	const dep = new FakeSessions();
	const { endpoint } = await setupSessions(t, dep, { sessionsMinIntervalMs: 250 });
	const a = await login(t, endpoint);
	a.send({ type: "sessions_list" });
	await a.wait((f) => f.type === "sessions");
	a.send({ type: "sessions_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "sessions").length === 2);
	assert.equal(dep.calls, 1, "second request served from cache");
	await sleep(300);
	a.send({ type: "sessions_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "sessions").length === 3);
	assert.equal(dep.calls, 2);
});

test("sessions_list is a read: it still answers while the global pause is on", async (t) => {
	const store = makePausedStore();
	const { endpoint } = await setupSessions(t, new FakeSessions(), { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	a.send({ type: "sessions_list" });
	const frame = await a.wait((f) => f.type === "sessions");
	assert.equal(frame.schema, "abito-sessions/view/1");
});

// ----- global pause (#379) ------------------------------------------------------

const makePausedStore = () => {
	const store = { paused: false, writes: [], get() { return store.paused; }, set(value) { store.writes.push(value); store.paused = value; } };
	return store;
};
const fakeConnectors = () => ({ snapshot: async () => ({ catalog: [], connectors: [] }) });
const fakeAgents = (log = {}) => ({
	log,
	async list() { log.listed = (log.listed ?? 0) + 1; return [{ id: "claude-code", state: "not_connected", backup: false, detail: null }]; },
	async connect(id) { log.connected = id; return [{ id, state: "working", backup: false, detail: null }]; },
	async disconnect(id) { log.disconnected = id; return [{ id, state: "not_connected", backup: false, detail: null }]; },
});

test("set_paused: persists, broadcasts agent_state{paused} to every client, resume restores", async (t) => {
	const store = makePausedStore();
	const { server, endpoint } = await setup(t, { pausedStore: store, limits: { maxClients: 5 } });
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await b.wait((f) => f.type === "agent_state" && f.paused === true);
	const state = a.frames.find((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(state.busy, false);
	assert.equal(server.paused, true);
	assert.deepEqual(store.writes, [true]);
	// visible to a late client through ready and status
	const c = await login(t, endpoint);
	assert.equal(c.frames[0].state.paused, true);
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	assert.equal(server.paused, false);
	assert.deepEqual(store.writes, [true, false]);
});

test("set_paused: non-boolean reaches the server as bad_request (validator) and changes nothing", async (t) => {
	const store = makePausedStore();
	const { server, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: "yes" });
	a.send({ type: "set_paused" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length >= 2);
	assert.ok(a.frames.filter((f) => f.type === "error").every((f) => f.code === "bad_request"));
	assert.equal(server.paused, false);
	assert.deepEqual(store.writes, []);
});

test("while paused, admission verbs are refused with error{paused} and change nothing", async (t) => {
	const store = makePausedStore();
	const connectorCalls = [];
	const connectors = { snapshot: async () => { connectorCalls.push("snap"); return { catalog: [], connectors: [] }; } };
	const agentLog = {};
	const agents = fakeAgents(agentLog);
	const { engine, endpoint } = await setup(t, { pausedStore: store, connectors, agents });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	const before = a.frames.length;
	for (const frame of [
		{ type: "send", text: "hi" },
		{ type: "steer", text: "go" },
		{ type: "agent_connect", agentId: "claude-code" },
		{ type: "connectors_list" },
		{ type: "agents_list" },
	]) a.send(frame);
	await waitFor(() => a.frames.slice(before).filter((f) => f.type === "error").length >= 5);
	assert.ok(a.frames.slice(before).filter((f) => f.type === "error").every((f) => f.code === "paused"), JSON.stringify(a.frames.slice(before)));
	// T4 U1: new_conversation is refused conversations_off regardless of the pause state.
	a.send({ type: "new_conversation" });
	await a.wait((f) => f.type === "error" && f.code === "conversations_off");
	// No turn was admitted, no process-spawning list ran, nothing was persisted again.
	assert.deepEqual(engine.requests, []);
	assert.deepEqual(connectorCalls, []);
	assert.deepEqual(agentLog, {});
	assert.deepEqual(store.writes, [true]);
	// A rejected send never flips busy.
	const st = a.frames.filter((f) => f.type === "agent_state").at(-1);
	assert.equal(st.busy, false);
});

test("while paused, agent_disconnect, abort and read-only verbs stay allowed; resume restores admission", async (t) => {
	const store = makePausedStore();
	const agentLog = {};
	const { engine, endpoint } = await setup(t, { pausedStore: store, connectors: fakeConnectors(), agents: fakeAgents(agentLog) });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	a.send({ type: "agent_disconnect", agentId: "claude-code" });
	await a.wait((f) => f.type === "agents");
	assert.equal(agentLog.disconnected, "claude-code");
	a.send({ type: "abort" });
	await waitFor(() => engine.requests.some((r) => r.type === "abort"));
	a.send({ type: "accounts_list" });
	await a.wait((f) => f.type === "accounts");
	// resume: a turn is admitted again
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	a.send({ type: "send", text: "hi" });
	await waitFor(() => engine.requests.at(-1)?.type === "prompt");
	assert.deepEqual(engine.requests.at(-1), { type: "prompt", message: "hi" });
});

test("pausing while a turn is active interrupts it (#378): daemon-level cancel, explained closed event, no raw abort", async (t) => {
	const store = makePausedStore();
	const { server, engine, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	engine.hold = true;
	a.send({ type: "send", text: "long turn" });
	await a.wait((f) => f.type === "agent_state" && f.busy === true);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(engine.interruptedWith, "paused");
	assert.deepEqual(engine.sent, [], "the interruption goes through the cancellation path, not a raw abort");
	const toast = a.frames.find((f) => f.type === "toast" && f.message === "La pausa interrumpió el turno del agente.");
	assert.ok(toast, "a closed event explains why the turn stopped");
	a.send({ type: "send", text: "again" });
	await waitFor(() => a.frames.some((f) => f.type === "error"));
	assert.equal(a.frames.find((f) => f.type === "error").code, "paused");
	assert.equal(engine.requests.length, 1, "no second turn admitted");
	// pausing when idle sends no interrupt
	assert.deepEqual(server.paused, true);
});

test("a boot that starts paused reports it in ready and status; pause without a store still switches in memory", async (t) => {
	const { server, endpoint } = await setup(t, { paused: true });
	const a = await login(t, endpoint);
	assert.equal(a.frames[0].state.paused, true);
	a.send({ type: "status" });
	const st = await a.wait((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(st.busy, false);
	// no persisted store wired: the switch still works in memory
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	assert.equal(server.paused, false);
	a.send({ type: "set_paused", paused: true });
	await waitFor(() => server.paused === true && a.frames.filter((f) => f.type === "agent_state" && f.paused === true).length >= 2);
	assert.equal(server.paused, true);
});

test("set_paused: a persistence failure answers failed, keeps the previous state and changes nothing", async (t) => {
	const store = makePausedStore();
	store.set = () => { throw new Error("disk gone"); };
	const { server, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "error");
	assert.equal(a.frames.find((f) => f.type === "error").code, "failed");
	assert.equal(server.paused, false);
	// admission still open
	a.send({ type: "send", text: "hi" });
	await waitFor(() => a.frames.some((f) => f.type === "agent_state" && f.busy === true));
});

// ----- HU-041 T6a-1: custom provider account frames, end to end (real manager + store) -----

test("custom provider: create -> key via auth_start/auth_reply -> discovery; guarded activation; nothing secret on the wire", async (t) => {
	const http = require("node:http");
	const { AccountManager, helperEnv } = require("../src/auth.cjs");
	const { ProfileStore } = require("../src/profiles.cjs");
	const root = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-custom-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const KEY = "sk-fake-SECRET-2468-DO-NOT-LEAK";
	const hits = [];
	const gateway = http.createServer((req, res) => {
		hits.push(req.headers.authorization);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "model-a" }] }));
	});
	await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
	t.after(() => gateway.close());
	const baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
	const accountsRoot = path.join(root, "island", "accounts");
	const manager = new AccountManager({
		accountsRoot,
		helper: { command: process.execPath, args: [path.join(__dirname, "fixtures", "fake-auth.cjs"), "--accounts-root", accountsRoot], env: helperEnv(process.env, { home: root, tmp: root }) },
	});
	t.after(() => manager.close());
	const engine = { status: "ready", async request() { return { success: true }; }, async stop() {}, async start() {} };
	const profiles = new ProfileStore({ islandRoot: path.join(root, "island"), agentDir: path.join(root, "island", "agent"), accounts: () => new Map(manager.listAccounts().map((a) => [a.accountId, a])), engine, restart: async () => {} });
	fs.mkdirSync(path.join(root, "island", "agent"), { recursive: true, mode: 0o700 });
	const server = new IslandServer({ runtimeDir: tmpRuntime(t), token: TOKEN, engine: new FakeEngine(), accounts: manager, profiles });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);

	for (const bad of [{ baseUrl: "http://gateway.example/v1" }, { baseUrl: "https://u:p@gateway.example/v1" }]) c.send({ type: "custom_account_create", label: "GW", ...bad });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "bad_request").length === 2);
	assert.deepEqual(manager.listAccounts(), []);

	c.send({ type: "custom_account_create", label: "Gateway", baseUrl });
	assert.deepEqual((await c.wait((f) => f.type === "account")).account, { accountId: "gateway", label: "Gateway", provider: "custom-gateway", authMethod: "none", configured: false, custom: true });
	c.send({ type: "custom_models_refresh", accountId: "gateway" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.equal(hits.length, 0, "no key: nothing is contacted");

	c.send({ type: "auth_start", accountId: "gateway", method: "api_key" });
	const started = await c.wait((f) => f.type === "auth_started");
	const prompt = await c.wait((f) => f.type === "auth_prompt");
	assert.equal(prompt.secret, true);
	c.send({ type: "auth_reply", flowId: started.flowId, promptId: prompt.promptId, value: KEY });
	assert.equal((await c.wait((f) => f.type === "auth_done")).ok, true);
	c.send({ type: "custom_models_refresh", accountId: "gateway" });
	await waitFor(() => types(c, "account").length === 2);
	assert.equal(hits.at(-1), `Bearer ${KEY}`);
	c.send({ type: "models_list", providerId: "custom-gateway", accountId: "gateway" });
	await c.wait((f) => f.type === "models");

	// T6a-2: the guarded transport is installed on activation (profile frames carry no URL/key).
	c.send({ type: "profile_save", id: "gw", label: "G", role: "main", accountId: "gateway", provider: "custom-gateway", modelId: "model-a" });
	await c.wait((f) => f.type === "profiles" && f.profiles.length === 1);
	c.send({ type: "profile_select", id: "gw" });
	await waitFor(() => profiles.list().active === "gw");
	assert.equal(fs.existsSync(path.join(root, "island", "agent", "extensions", "abito-custom-provider.js")), true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "island", "agent", "custom-provider.json"), "utf8")).baseUrl, baseUrl);
	c.send({ type: "profile_save", id: "bad", label: "B", role: "main", accountId: "gateway", provider: "custom-gateway", modelId: "model-z" });
	await c.wait((f) => f.type === "profiles" && f.profiles.length === 2);
	c.send({ type: "profile_select", id: "bad" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.equal(profiles.list().active, "gw", "a refused activation changes nothing");

	c.send({ type: "accounts_list" });
	await c.wait((f) => f.type === "accounts" && f.accounts.length === 1 && f.accounts[0].configured === true);
	const wire = JSON.stringify(c.frames);
	for (const banned of [KEY, "sk-fake", "127.0.0.1", "baseUrl"]) assert.equal(wire.includes(banned), false, banned);
});

test("a refused (non-private) credential store reaches the client as the closed code store_not_private, not as a generic failure", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const { CredentialStoreError } = require("../src/auth.cjs");
	accounts.createAccount = async () => { throw new CredentialStoreError(); };
	const c = await login(t, endpoint);
	c.send({ type: "account_create", label: "x", provider: "p" });
	await c.wait((f) => f.type === "error" && f.code === "store_not_private");
});

// ----- K2-05 T4 U1: history ---------------------------------------------------

test("ready features: history on, conversations off (one continuous chat)", async (t) => {
	const { endpoint } = await setup(t);
	const c = await login(t, endpoint);
	assert.deepEqual(c.frames[0].features, { history: true, conversations: false });
});

/** A v3 session file whose message entries the projection reads back. */
function writeChatSession(dir, name, messages) {
	const file = path.join(dir, name);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: dir }),
		...messages.map((entry) => JSON.stringify(entry)),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

test("get_history projects the whole rotated chain oldest first; assistant text is white-labelled, user text is not", async (t) => {
	const { endpoint, engine, server } = await setup(t);
	const dir = engine.sessionsDir;
	const f1 = writeChatSession(dir, "one.jsonl", [
		{ type: "message", message: { role: "user", content: "mi engram" } },
		{ type: "message", message: { role: "assistant", content: "leo tu engram del Gentle Shell" } },
	]);
	const f2 = writeChatSession(dir, "two.jsonl", [
		{ type: "message", message: { role: "user", content: "sigue" } },
		{ type: "message", message: { role: "assistant", content: "ok" } },
	]);
	const f3 = writeChatSession(dir, "three.jsonl", [{ type: "message", message: { role: "user", content: "última" } }]);
	engine.sessionFile = f3;
	engine.chains[f3] = [f1, f2];
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	const frame = await c.wait((f) => f.type === "history");
	assert.deepEqual(
		frame.messages.map((m) => [m.id, m.role, m.text, m.earlier]),
		[
			["s0-1", "user", "mi engram", true],
			["s0-2", "assistant", "leo tu memory del Koda", true],
			["s1-1", "user", "sigue", true],
			["s1-2", "assistant", "ok", true],
			["s2-1", "user", "última", undefined],
		],
	);
	assert.equal(frame.hasEarlier, false);
	assert.deepEqual(engine.requests, [{ type: "get_state" }], "the freshness round trip (Gentle Dot's currentHistory) is the only engine traffic");
	await server.close();
});

test("get_earlier pages backwards; an unknown but valid before yields an empty page", async (t) => {
	const { endpoint, engine } = await setup(t);
	const dir = engine.sessionsDir;
	const f1 = writeChatSession(dir, "one.jsonl", [
		{ type: "message", message: { role: "user", content: "a" } },
		{ type: "message", message: { role: "assistant", content: "b" } },
	]);
	const f2 = writeChatSession(dir, "two.jsonl", [{ type: "message", message: { role: "user", content: "c" } }]);
	engine.sessionFile = f2;
	engine.chains[f2] = [f1];
	const c = await login(t, endpoint);
	c.send({ type: "get_earlier", before: "s1-1" });
	const frame = await c.wait((f) => f.type === "earlier");
	assert.equal(frame.before, "s1-1");
	assert.deepEqual(frame.messages.map((m) => m.id), ["s0-1", "s0-2"]);
	assert.equal(frame.hasEarlier, false);
	c.send({ type: "get_earlier", before: "s9-9" });
	const empty = await c.wait((f) => f.type === "earlier" && f.before === "s9-9");
	assert.deepEqual(empty.messages, []);
	assert.equal(empty.hasEarlier, false, "the island keeps what it already shows");
	c.send({ type: "get_earlier", before: "garbage" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
});

test("get_history and get_earlier are unavailable without a ready engine or an open session", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	engine.status = "ready";
	c.send({ type: "get_earlier", before: "s0-1" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable", 3000);
});

// K2-05 boot order (Gentle Dot daemon.ts:470-481 + bridge.ts deriveState/whenReady): the daemon
// listens before its engine is ready, so clients connect while it starts.
test("a client connecting before the engine was launched reads starting, like Gentle Dot's deriveState", async (t) => {
	const { endpoint, engine } = await setup(t);
	engine.status = "stopped";
	engine.launched = false;
	const c = await login(t, endpoint);
	assert.equal(c.frames.find((f) => f.type === "ready").state.status, "starting");
	c.send({ type: "send", text: "hola", requestId: "r-boot-1" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	assert.deepEqual(engine.requests, [], "nothing reaches an engine that is not ready");
	engine.launched = true;
	c.send({ type: "status" });
	await c.wait((f) => f.type === "agent_state" && f.status === "stopped");
});

test("get_history asked while the engine starts waits and is answered once it is ready (Gentle Dot whenReady)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const file = writeChatSession(engine.sessionsDir, "saved.jsonl", [
		{ type: "message", message: { role: "user", content: "hola" } },
		{ type: "message", message: { role: "assistant", content: "buenas" } },
	]);
	engine.status = "starting";
	const c = await login(t, endpoint);
	assert.equal(c.frames.find((f) => f.type === "ready").state.status, "starting");
	c.send({ type: "get_history" });
	c.send({ type: "send", text: "hola", requestId: "r-boot-2" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	await sleep(80);
	assert.equal(c.frames.some((f) => f.type === "history"), false, "no page while the engine starts");
	assert.equal(c.frames.filter((f) => f.type === "error").length, 1, "the history read is not refused");
	engine.status = "restarting";
	engine.emit("status", { state: "restarting" });
	await c.wait((f) => f.type === "agent_state" && f.status === "restarting");
	engine.sessionFile = file;
	engine.status = "ready";
	engine.emit("status", { state: "ready" });
	const page = await c.wait((f) => f.type === "history");
	assert.deepEqual(page.messages.map((m) => m.text), ["hola", "buenas"]);
});

test("get_history waiting for a starting engine is refused unavailable when the engine stops instead", async (t) => {
	const { endpoint, engine, server } = await setup(t);
	engine.status = "starting";
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	await sleep(40);
	engine.status = "stopped";
	engine.launched = true;
	engine.emit("status", { state: "stopped" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	// Many reads while the engine starts share ONE engine listener (no pile-up on the emitter).
	engine.status = "starting";
	const before = engine.listenerCount("status");
	for (let i = 0; i < 20; i += 1) c.send({ type: "get_history" });
	await waitFor(() => engine.listenerCount("status") === before + 1);
	await sleep(40);
	assert.equal(engine.listenerCount("status"), before + 1);
	engine.status = "stopped";
	engine.emit("status", { state: "stopped" });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "unavailable").length === 21);
	assert.equal(engine.listenerCount("status"), before, "the shared wait leaves no listener behind");
	// A wait still open when the server closes never hangs.
	engine.status = "starting";
	c.send({ type: "get_history" });
	await sleep(40);
	await server.close();
});

test("each read held for a starting engine times out on its own deadline, like Gentle Dot's per-call whenReady timer", async (t) => {
	// Gentle Dot starts the timer INSIDE whenReady (bridge.ts:729-747), so a read asked later gets
	// its own deadline counted from the moment it was asked; Koda keeps ONE engine listener for
	// every held read (asserted below), but that sharing must never move a deadline onto an
	// earlier call.
	const { endpoint, engine } = await setup(t, { limits: { readyWaitMs: 500 } });
	engine.status = "starting";
	const c = await login(t, endpoint);
	const askedAt = [];
	const failedAt = [];
	c.send({ type: "get_history" });
	askedAt.push(Date.now());
	await sleep(300);
	c.send({ type: "get_history" });
	askedAt.push(Date.now());
	const deadline = Date.now() + 5000;
	while (failedAt.length < 2 && Date.now() < deadline) {
		const errors = c.frames.filter((f) => f.type === "error" && f.code === "unavailable").length;
		while (failedAt.length < errors) failedAt.push(Date.now());
		if (failedAt.length < 2) await sleep(5);
	}
	assert.equal(failedAt.length, 2, "both held reads end unavailable when the engine never starts");
	assert.ok(failedAt[0] - askedAt[0] >= 450, `the first read waits its own deadline (${failedAt[0] - askedAt[0]} ms)`);
	assert.ok(
		failedAt[1] - askedAt[1] >= 450,
		`the second read waits its OWN deadline, counted from when it was asked (${failedAt[1] - askedAt[1]} ms; sharing the first read's timer would end it ${failedAt[0] - askedAt[1]} ms after it asked)`,
	);
	assert.ok(failedAt[1] - failedAt[0] >= 250, "the two deadlines stay 300 ms apart, as the two reads did");
	// Many reads while the engine starts still share ONE engine listener (no pile-up on the emitter).
	engine.status = "starting";
	const before = engine.listenerCount("status");
	for (let i = 0; i < 10; i += 1) c.send({ type: "get_history" });
	await waitFor(() => engine.listenerCount("status") === before + 1);
	engine.status = "ready";
	engine.emit("status", { state: "ready" });
	await waitFor(() => engine.listenerCount("status") === before);
});

test("new_conversation is refused conversations_off before any gate: idle, busy and paused; nothing reaches the engine", async (t) => {
	const store = { paused: false, get() { return store.paused; }, set(value) { store.paused = value; } };
	const { endpoint, engine } = await setup(t, { pausedStore: store });
	const c = await login(t, endpoint);
	// Idle.
	c.send({ type: "new_conversation" });
	await c.wait((f) => f.type === "error" && f.code === "conversations_off");
	// Busy.
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "new_conversation" });
	await c.wait((f) => f.type === "error");
	const busyRefusal = c.frames.filter((f) => f.type === "error").at(-1);
	assert.equal(busyRefusal.code, "conversations_off");
	// Paused.
	c.send({ type: "set_paused", paused: true });
	await c.wait((f) => f.type === "agent_state" && f.paused === true);
	c.send({ type: "new_conversation" });
	const pausedRefusal = await c.wait((f) => f.type === "error" && f.code === "conversations_off");
	assert.equal(pausedRefusal.code, "conversations_off");
	assert.equal(engine.requests.length, 0, "no new_session ever reaches the engine");
	engine.emit("event", { type: "agent_settled" });
});

test("after a rotation the history is re-broadcast to every client, marked earlier (bridge.ts:1124-1129)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const dir = engine.sessionsDir;
	const f1 = writeChatSession(dir, "one.jsonl", [{ type: "message", message: { role: "user", content: "antigua" } }]);
	const f2 = writeChatSession(dir, "two.jsonl", [{ type: "message", message: { role: "user", content: "nueva" } }]);
	engine.sessionFile = f2;
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	// A link for a session the engine does not hold yet (the rotation links before switching): silent.
	engine.chains[f1] = [f1];
	engine.emit("sessions_linked", { sessionFile: f1 });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(a.frames.some((f) => f.type === "history"), false);
	// The switch confirms: the linked file IS the open one, and it carries its chain.
	engine.chains[f2] = [f1];
	engine.emit("session_changed", { sessionFile: f2 });
	for (const c of [a, b]) {
		const frame = await c.wait((f) => f.type === "history");
		assert.deepEqual(
			frame.messages.map((m) => [m.id, m.text, m.earlier]),
			[["s0-1", "antigua", true], ["s1-1", "nueva", undefined]],
			"the same chat, now marked earlier (the page limit keeps the entire small chain together)",
		);
		assert.equal(frame.hasEarlier, false, "the whole chain still fits one page");
	}
	// A session_changed without a linked chain (the rotation fallback's window) stays silent.
	engine.chains[f2] = [];
	engine.emit("session_changed", { sessionFile: f2 });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(a.frames.filter((f) => f.type === "history").length, 1);
	// While the engine is not ready, nothing is broadcast.
	engine.status = "restarting";
	engine.emit("sessions_linked", { sessionFile: f2 });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(a.frames.filter((f) => f.type === "history").length, 1);
});

// ----- K2-05 T4 U1 verifier fixes -------------------------------------------

/** The island reader's per-frame limit (agentclient.rs FrameError::TooLarge). */
const ISLAND_FRAME_LIMIT = 256 * 1024;
/** The daemon's own byte budget for one history page, safely below it. */
const PAGE_BUDGET = 192 * 1024;
/** Numeric order of the page ids `s<file>-<turn>`. */
const idOrder = (id) => {
	const [, f, t] = /^(\d+)-(\d+)$/.exec(id.slice(1));
	return Number(f) * 1e9 + Number(t);
};

test("get_history frames never exceed the island reader's limit; walking get_earlier returns every turn exactly once", async (t) => {
	const { endpoint, engine } = await setup(t);
	const dir = engine.sessionsDir;
	const lines = [JSON.stringify({ type: "session", version: 3, id: "long", timestamp: "t", cwd: dir })];
	for (let i = 1; i <= 60; i++) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: `pregunta ${i} sobre el procedimiento completo de despliegue` } }));
		lines.push(JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `respuesta ${i}: ${"x".repeat(2700)}` },
					...Array.from({ length: 20 }, (_, k) => ({ type: "toolCall", id: `t${i}-${k}`, name: "read", arguments: { path: `/proyecto/modulo${k}/archivo-con-nombre-largo.ts` } })),
				],
			},
		}));
	}
	const file = path.join(dir, "long.jsonl");
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	engine.sessionFile = file;
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	const first = await c.wait((f) => f.type === "history");
	assert.ok(Buffer.byteLength(JSON.stringify(first)) <= PAGE_BUDGET, `one page stays under the island-safe budget`);
	assert.ok(Buffer.byteLength(JSON.stringify(first)) <= ISLAND_FRAME_LIMIT, `and under the island reader's own limit`);
	assert.equal(first.hasEarlier, true, "a bounded long chat has earlier pages");
	// Walk back exactly the way the island does: the oldest id of each page is the cursor.
	const seen = [...first.messages];
	let cursor = first.messages[0].id; // the OLDEST id of the page the island already shows
	for (let guard = 0; cursor && guard < 100; guard++) {
		c.send({ type: "get_earlier", before: cursor });
		const frame = await c.wait((f) => f.type === "earlier" && f.before === cursor);
		if (frame.messages.length === 0) {
			assert.equal(frame.hasEarlier, false, "the walk ends with a consistent empty page");
			break;
		}
		assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= PAGE_BUDGET, `every frame fits (${seen.length} in)`);
		seen.push(...frame.messages);
		cursor = frame.messages[0].id;
	}
	const ids = seen.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "no turn is repeated");
	assert.deepEqual(
		[...ids].sort((a, b) => idOrder(a) - idOrder(b)),
		Array.from({ length: 120 }, (_, i) => `s0-${i + 1}`),
		"every turn exactly once",
	);
});

test("get_history includes a reply the engine announced but persisted late (Gentle Dot's currentHistory round trip)", async (t) => {
	const { endpoint, engine } = await setup(t);
	const dir = engine.sessionsDir;
	const append = (text) => fs.appendFileSync(path.join(dir, "fresh.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", content: text } })}\n`);
	const f1 = writeChatSession(dir, "fresh.jsonl", [{ type: "message", message: { role: "user", content: "primera" } }]);
	engine.sessionFile = f1;
	// The reply settles: the island hears the announcement (the engine event), but the
	// session file only gains the message when a get_state round trip reaches the engine.
	engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tardía" } });
	// A SECOND announcement lands while that round trip is in flight; its message is
	// persisted only by the retry's own round trip, so the page must be read again.
	engine.onGetState = () => {
		engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "segunda" } });
		engine.pendingPersist = () => append("respuesta segunda");
	};
	engine.pendingPersist = () => append("respuesta tardía");
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	const frame = await c.wait((f) => f.type === "history");
	assert.equal(frame.messages.at(-1).text, "respuesta tardía\n\nrespuesta segunda", "both replies are in: the pre-read one and the one announced during the round trip (the retry)");
	assert.equal(frame.messages.length, 2, "user + the merged assistant turn");
});

test("a chain entry that is a symlink or lives outside the sessions dir is never read, even holding a secret", async (t) => {
	const { endpoint, engine } = await setup(t);
	const dir = engine.sessionsDir;
	const outside = path.join(dir, "..", "outside-secret.jsonl");
	fs.writeFileSync(outside, `${JSON.stringify({ type: "message", message: { role: "user", content: "OUTSIDE-SECRET" } })}\n`);
	t.after(() => fs.rmSync(outside, { force: true }));
	const planted = path.join(dir, "planted.jsonl");
	fs.symlinkSync(outside, planted);
	const own = writeChatSession(dir, "own.jsonl", [{ type: "message", message: { role: "user", content: "propia" } }]);
	engine.sessionFile = own;
	engine.chains[own] = [planted, outside];
	const c = await login(t, endpoint);
	c.send({ type: "get_history" });
	const frame = await c.wait((f) => f.type === "history");
	assert.deepEqual(frame.messages.map((m) => [m.id, m.text]), [["s0-1", "propia"]], "only the owned session file projects");
	assert.ok(!JSON.stringify(frame).includes("OUTSIDE-SECRET"), "the planted secret never reaches a client");
	assert.equal(frame.hasEarlier, false, "refused entries do not invent earlier pages");
});

// ----- K2-05 bind by id (Gentle Dot bridge.ts onMessageStart + send requestId dedupe) ---------

/** The engine announces a user message it records (Pi's message_start, role user). */
const recordUser = (engine, content) => engine.emit("event", { type: "message_start", message: { role: "user", content } });
/** The engine persists one message to the open session file (Pi appends on message_end). */
const persist = (engine, role, content) => fs.appendFileSync(engine.sessionFile, `${JSON.stringify({ type: "message", message: { role, content } })}\n`);
const userMessages = (c) => c.frames.filter((f) => f.type === "user_message");

async function chatOnFile(t, existing = []) {
	const ctx = await setup(t);
	const dir = ctx.engine.sessionsDir;
	const old = writeChatSession(dir, "old.jsonl", [
		{ type: "message", message: { role: "user", content: "antes" } },
		{ type: "message", message: { role: "assistant", content: "r-antes" } },
	]);
	ctx.engine.sessionFile = writeChatSession(dir, "open.jsonl", existing);
	ctx.engine.chains[ctx.engine.sessionFile] = [old];
	return ctx;
}

test("user_message: the recorded prompt is broadcast with its record id; the requestId reaches the sender only", async (t) => {
	const { endpoint, engine } = await chatOnFile(t, [
		{ type: "message", message: { role: "user", content: "vieja" } },
		{ type: "message", message: { role: "assistant", content: "r-vieja" } },
	]);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "send", text: "hola Gentle Shell", requestId: "isla-1" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	recordUser(engine, "hola Gentle Shell");
	const own = await a.wait((f) => f.type === "user_message");
	const theirs = await b.wait((f) => f.type === "user_message");
	assert.deepEqual({ ...own, seq: 0 }, { type: "user_message", messageId: "s1-3", text: "hola Gentle Shell", requestId: "isla-1", seq: 0 }, "the user's own text, never white-labelled");
	assert.deepEqual({ ...theirs, seq: 0 }, { type: "user_message", messageId: "s1-3", text: "hola Gentle Shell", seq: 0 }, "other clients see the record without the requestId");
	// joinable: once persisted, history names the same prompt with the same id
	persist(engine, "user", "hola Gentle Shell");
	persist(engine, "assistant", "hola");
	engine.emit("event", { type: "agent_settled" });
	b.send({ type: "get_history" });
	const page = await b.wait((f) => f.type === "history");
	assert.deepEqual(page.messages.find((m) => m.id === own.messageId), { id: "s1-3", role: "user", text: "hola Gentle Shell", activities: [] });
});

test("user_message: two clients with identical text each get their own record id; other prompts carry no requestId", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	b.send({ type: "send", text: "hola", requestId: "otro-1" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	await a.wait((f) => f.type === "agent_state" && f.busy);
	a.send({ type: "steer", text: "hola", requestId: "isla-1" });
	await waitFor(() => engine.requests.some((r) => r.type === "steer"));
	// the engine records b's prompt, answers, then consumes a's steer
	recordUser(engine, "hola");
	persist(engine, "user", "hola");
	engine.emit("event", { type: "message_start", message: { role: "assistant" } });
	persist(engine, "assistant", "r1");
	recordUser(engine, "hola");
	persist(engine, "user", "hola");
	// an extension's own user message: nobody's request
	recordUser(engine, "despertar");
	await waitFor(() => userMessages(a).length === 3 && userMessages(b).length === 3);
	assert.deepEqual(userMessages(b).map((f) => [f.messageId, f.text, f.requestId]), [["s1-1", "hola", "otro-1"], ["s1-3", "hola", undefined], ["s1-4", "despertar", undefined]]);
	assert.deepEqual(userMessages(a).map((f) => [f.messageId, f.text, f.requestId]), [["s1-1", "hola", undefined], ["s1-3", "hola", "isla-1"], ["s1-4", "despertar", undefined]]);
});

test("a repeated requestId is ignored (send and steer), like Gentle Dot's dedupe", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	a.send({ type: "send", text: "hola", requestId: "r-1" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	a.send({ type: "steer", text: "más", requestId: "r-2" });
	a.send({ type: "steer", text: "más", requestId: "r-2" });
	a.send({ type: "steer", text: "otro", requestId: "r-1" });
	a.send({ type: "status" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").length >= 2);
	await sleep(30);
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	a.send({ type: "send", text: "hola", requestId: "r-1" });
	a.send({ type: "send", text: "nueva", requestId: "r-3" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
	await sleep(30);
	assert.deepEqual(engine.requests.filter((r) => r.type === "prompt" || r.type === "steer").map((r) => [r.type, r.message]), [["prompt", "hola"], ["steer", "más"], ["prompt", "nueva"]]);
	assert.equal(a.frames.some((f) => f.type === "error"), false, "a repeat is ignored silently, never an error");
});

test("a failed send or steer never claims a record: the next recorded prompt carries no requestId", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	engine.reject = ["prompt"];
	a.send({ type: "send", text: "hola", requestId: "r-fail" });
	await a.wait((f) => f.type === "error" && f.code === "failed");
	engine.reject = ["steer"];
	engine.emit("event", { type: "agent_start" });
	await a.wait((f) => f.type === "agent_state" && f.busy);
	a.send({ type: "steer", text: "hola", requestId: "r-fail-2" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 2);
	recordUser(engine, "hola");
	const frame = await a.wait((f) => f.type === "user_message");
	assert.equal(frame.requestId, undefined, "a request the engine refused never names a record");
	assert.equal(frame.messageId, "s1-1");
});

test("an expanded prompt (the engine records other text) still binds to its send; settled turns forget stale requests", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	a.send({ type: "send", text: "/plantilla", requestId: "r-exp" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	recordUser(engine, "texto expandido de la plantilla");
	const own = await a.wait((f) => f.type === "user_message");
	assert.equal(own.requestId, "r-exp");
	a.send({ type: "steer", text: "nunca registrado", requestId: "r-stale" });
	await waitFor(() => engine.requests.some((r) => r.type === "steer"));
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	recordUser(engine, "nunca registrado");
	await waitFor(() => userMessages(a).length === 2);
	assert.equal(userMessages(a)[1].requestId, undefined, "a request the settled turn never recorded can no longer claim a later record");
});

test("a prompt held during a rotation keeps its requestId until the engine records it", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	engine.sessionChange = { switching: true };
	a.send({ type: "send", text: "retenido", requestId: "r-held" });
	await sleep(30);
	assert.equal(engine.requests.some((r) => r.type === "prompt"), false);
	engine.sessionChange = undefined;
	engine.emit("status", { state: "ready" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	recordUser(engine, "retenido");
	assert.equal((await a.wait((f) => f.type === "user_message")).requestId, "r-held");
});

test("two prompts held during a rotation: the refused one never takes the delivered one's requestId (F1)", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	engine.sessionChange = { switching: true };
	a.send({ type: "send", text: "primero", requestId: "r-held-a" });
	b.send({ type: "send", text: "segundo", requestId: "r-held-b" });
	await sleep(30);
	assert.equal(engine.requests.some((r) => r.type === "prompt"), false, "both are held during the switch");
	// the real runtime refuses a second prompt while the first one's turn runs (runtime.cjs request)
	const request = engine.request.bind(engine);
	engine.request = async (command) => {
		if (command.type === "prompt" && engine.requests.some((r) => r.type === "prompt")) {
			engine.requests.push(command);
			throw new Error("engine is busy");
		}
		return request(command);
	};
	engine.sessionChange = undefined;
	engine.emit("status", { state: "ready" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
	await b.wait((f) => f.type === "error" && f.code === "failed");
	assert.equal(a.frames.some((f) => f.type === "error"), false, "the delivered prompt's sender gets no error");
	engine.emit("event", { type: "agent_start" });
	recordUser(engine, "primero");
	const own = await a.wait((f) => f.type === "user_message");
	const theirs = await b.wait((f) => f.type === "user_message");
	assert.equal(own.requestId, "r-held-a", "the delivered prompt is announced with its own sender's requestId");
	assert.equal(theirs.requestId, undefined, "the refused prompt's sender never gets a requestId");
	assert.equal(own.messageId, "s1-1");
});

test("a steer the engine rewrites (template) still binds to its request, by order (F4)", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	b.send({ type: "send", text: "pregunta", requestId: "r-prompt" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	await a.wait((f) => f.type === "agent_state" && f.busy);
	a.send({ type: "steer", text: "/plantilla x", requestId: "r-steer-1" });
	a.send({ type: "steer", text: "literal", requestId: "r-steer-2" });
	await waitFor(() => engine.requests.filter((r) => r.type === "steer").length === 2);
	recordUser(engine, "pregunta");
	persist(engine, "user", "pregunta");
	// the engine records the first steer expanded (other text), then the second as typed
	recordUser(engine, "texto expandido de la plantilla x");
	persist(engine, "user", "texto expandido de la plantilla x");
	recordUser(engine, "literal");
	persist(engine, "user", "literal");
	// nothing is pending any more: an extension's own message is nobody's
	recordUser(engine, "despertar");
	await waitFor(() => userMessages(a).length === 4 && userMessages(b).length === 4);
	assert.deepEqual(userMessages(a).map((f) => [f.messageId, f.requestId]), [["s1-1", undefined], ["s1-2", "r-steer-1"], ["s1-3", "r-steer-2"], ["s1-4", undefined]]);
	assert.deepEqual(userMessages(b).map((f) => [f.messageId, f.requestId]), [["s1-1", "r-prompt"], ["s1-2", undefined], ["s1-3", undefined], ["s1-4", undefined]]);
});

test("user_message for a 64 Ki-char prompt is one bounded frame under the island reader's limit", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	let biggest = 0;
	a.socket.on("data", () => {});
	const text = "€".repeat(P.LIMITS.maxTextChars);
	a.send({ type: "send", text, requestId: "r-big" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	recordUser(engine, text);
	const frame = await a.wait((f) => f.type === "user_message");
	biggest = Buffer.byteLength(JSON.stringify(frame));
	assert.ok(biggest <= 192 * 1024, `${biggest} bytes`);
	assert.equal(frame.clipped, true);
	assert.equal(frame.requestId, "r-big");
});

test("the record id never depends on when the engine writes the file (Pi persists right after message_start)", async (t) => {
	const { endpoint, engine } = await chatOnFile(t, [
		{ type: "message", message: { role: "user", content: "vieja" } },
		{ type: "message", message: { role: "assistant", content: "r-vieja" } },
	]);
	const a = await login(t, endpoint);
	a.send({ type: "send", text: "hola", requestId: "r-race" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	// the engine already appended the user message when the daemon handles its message_start
	persist(engine, "user", "hola");
	recordUser(engine, "hola");
	// a tool round: assistant, tool result, assistant again — ONE display row, as history projects it
	for (const role of ["assistant", "toolResult", "assistant"]) {
		persist(engine, role, role === "toolResult" ? "ok" : "r");
		engine.emit("event", { type: "message_start", message: { role } });
	}
	persist(engine, "user", "dos");
	recordUser(engine, "dos");
	await waitFor(() => userMessages(a).length === 2);
	assert.deepEqual(userMessages(a).map((f) => [f.messageId, f.requestId]), [["s1-3", "r-race"], ["s1-5", undefined]]);
	engine.emit("event", { type: "agent_settled" });
	a.send({ type: "get_history" });
	const page = await a.wait((f) => f.type === "history");
	assert.deepEqual(page.messages.filter((m) => m.role === "user").map((m) => [m.id, m.text]), [["s0-1", "antes"], ["s1-1", "vieja"], ["s1-3", "hola"], ["s1-5", "dos"]]);
});

// ----- K2-05 native-review follow-ups (advisory findings at 9e6aac6) ---------------------------

test("review F1: a requestId refused by a transient gate (busy, not ready, paused, not busy) is accepted on retry", async (t) => {
	const { endpoint, engine, server } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const errors = () => a.frames.filter((f) => f.type === "error").length;
	// busy: another prompt runs
	a.send({ type: "send", text: "primero", requestId: "r-first" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	a.send({ type: "send", text: "reintento", requestId: "r-busy" });
	await a.wait((f) => f.type === "error" && f.code === "busy");
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1)?.busy === false);
	// not busy: a steer with no turn running
	a.send({ type: "steer", text: "giro", requestId: "r-steer" });
	await waitFor(() => errors() === 2);
	// not ready: the engine restarts
	engine.status = "restarting";
	a.send({ type: "send", text: "caído", requestId: "r-down" });
	await waitFor(() => errors() === 3);
	engine.status = "ready";
	// paused
	server.paused = true;
	a.send({ type: "send", text: "pausa", requestId: "r-paused" });
	await waitFor(() => errors() === 4);
	server.paused = false;
	assert.deepEqual(a.frames.filter((f) => f.type === "error").map((f) => f.code), ["busy", "not_busy", "unavailable", "paused"]);
	// each retry with the SAME requestId reaches the engine once the gate is gone
	a.send({ type: "send", text: "reintento", requestId: "r-busy" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
	a.send({ type: "steer", text: "giro", requestId: "r-steer" });
	await waitFor(() => engine.requests.some((r) => r.type === "steer"));
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1)?.busy === false);
	a.send({ type: "send", text: "caído", requestId: "r-down" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 3);
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1)?.busy === false);
	a.send({ type: "send", text: "pausa", requestId: "r-paused" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 4);
	// an accepted id stays spent: its repeat is ignored silently, even while its own turn runs
	a.send({ type: "send", text: "pausa", requestId: "r-paused" });
	a.send({ type: "send", text: "primero", requestId: "r-first" });
	await sleep(30);
	assert.deepEqual(engine.requests.filter((r) => r.type === "prompt" || r.type === "steer").map((r) => [r.type, r.message]),
		[["prompt", "primero"], ["prompt", "reintento"], ["steer", "giro"], ["prompt", "caído"], ["prompt", "pausa"]]);
	assert.equal(errors(), 4, "a repeat of an accepted id is never an error");
});

test("review F1: a second prompt held during a rotation is refused without spending its requestId", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	engine.sessionChange = { switching: true };
	a.send({ type: "send", text: "retenido", requestId: "r-held-1" });
	a.send({ type: "send", text: "otro", requestId: "r-held-2" });
	await a.wait((f) => f.type === "error" && f.code === "busy");
	// the held prompt's own repeat is ignored (it was accepted)
	a.send({ type: "send", text: "retenido", requestId: "r-held-1" });
	engine.sessionChange = undefined;
	engine.emit("status", { state: "ready" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => a.frames.filter((f) => f.type === "agent_state").at(-1)?.busy === false);
	a.send({ type: "send", text: "otro", requestId: "r-held-2" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
	await sleep(30);
	assert.deepEqual(engine.requests.filter((r) => r.type === "prompt").map((r) => r.message), ["retenido", "otro"]);
});

test("review F2: an unmatched record never hands a requestId to the wrong client when steers of two clients wait", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	b.send({ type: "send", text: "pregunta", requestId: "r-prompt" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	engine.emit("event", { type: "agent_start" });
	await a.wait((f) => f.type === "agent_state" && f.busy);
	a.send({ type: "steer", text: "/plantilla a", requestId: "r-steer-a" });
	await waitFor(() => engine.requests.filter((r) => r.type === "steer").length === 1);
	b.send({ type: "steer", text: "/plantilla b", requestId: "r-steer-b" });
	await waitFor(() => engine.requests.filter((r) => r.type === "steer").length === 2);
	recordUser(engine, "pregunta");
	persist(engine, "user", "pregunta");
	// an extension's own user message while both steers wait: nobody's request
	recordUser(engine, "despertar");
	persist(engine, "user", "despertar");
	// then each steer, expanded by the engine (other text than what was typed)
	recordUser(engine, "texto expandido a");
	persist(engine, "user", "texto expandido a");
	recordUser(engine, "texto expandido b");
	persist(engine, "user", "texto expandido b");
	await waitFor(() => userMessages(a).length === 4 && userMessages(b).length === 4);
	const ids = (c) => userMessages(c).map((f) => [f.messageId, f.requestId]);
	// a requestId is only ever echoed for a record that is that client's own
	for (const [messageId, requestId] of ids(a)) if (requestId !== undefined) assert.equal([messageId, requestId].join(), ["s1-3", "r-steer-a"].join(), `a got ${requestId} on ${messageId}`);
	for (const [messageId, requestId] of ids(b)) if (requestId !== undefined) assert.ok(messageId === "s1-1" && requestId === "r-prompt" || messageId === "s1-4" && requestId === "r-steer-b", `b got ${requestId} on ${messageId}`);
	assert.deepEqual(ids(b)[0], ["s1-1", "r-prompt"], "the dispatched prompt still binds");
});

test("review F6: an error answering a send carries that send's requestId (only to its sender)", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	engine.reject = ["prompt"];
	a.send({ type: "send", text: "hola", requestId: "r-rejected" });
	const rejected = await a.wait((f) => f.type === "error");
	assert.equal(rejected.code, "failed");
	assert.equal(rejected.requestId, "r-rejected", "the engine's rejection names the send it answers");
	engine.reject = undefined;
	a.send({ type: "send", text: "otra", requestId: "r-ok" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
	a.send({ type: "send", text: "ocupado", requestId: "r-busy" });
	const busy = await a.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(busy.requestId, "r-busy");
	a.send({ type: "send", text: "sin id" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 3);
	assert.equal(a.frames.filter((f) => f.type === "error").at(-1).requestId, undefined, "no requestId, none echoed");
	await sleep(30);
	assert.equal(b.frames.some((f) => f.type === "error"), false, "nobody else gets the sender's error");
});

// ----- K2-05 attachments (L11 2a; Gentle Dot uploads.ts + bridge.ts attachedFiles/composePrompt) ------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CHUNK = 6;
/** Uploads one file in CHUNK-byte base64 chunks and waits for the daemon's answer (uploaded or error). */
async function upload(c, name, bytes, requestId) {
	const parts = bytes.length === 0 ? [Buffer.alloc(0)] : Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, i) => bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
	let offset = 0;
	for (const part of parts) {
		c.send({ type: "upload", requestId, name, size: bytes.length, offset, data: part.toString("base64") });
		offset += part.length;
	}
	return c.wait((f) => f.requestId === requestId && (f.type === "uploaded" || f.type === "error"));
}
const uploadsDir = (engine) => path.join(engine.island.workspace, "uploads");

test("attachments: a file uploaded over the channel is stored in the engine workspace; only its sender learns its id", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const done = await upload(a, "../../secreto/informe.txt", Buffer.from("hola mundo"), "up-1");
	assert.equal(done.type, "uploaded");
	assert.match(done.attachment.id, /^a-[0-9a-f]{16}$/);
	assert.deepEqual({ ...done.attachment, id: "x" }, { id: "x", name: "informe.txt", size: 10, mime: "application/octet-stream" });
	assert.equal(fs.readFileSync(path.join(uploadsDir(engine), done.attachment.id, "informe.txt"), "utf8"), "hola mundo");
	assert.equal(JSON.stringify(a.frames).includes(engine.island.workspace), false, "the stored path never travels");
	await sleep(30);
	assert.equal(b.frames.some((f) => f.type === "uploaded"), false);
	assert.equal(engine.requests.length, 0, "an upload never reaches the engine");
});

test("attachments: send composes Gentle Dot's prompt (path read as the engine, image inline for a vision model); user_message and history show the chips", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	engine.stateData = { model: { id: "vision", input: ["text", "image"] } };
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const img = (await upload(a, "foto.png", PNG_BYTES, "up-img")).attachment;
	const doc = (await upload(a, "datos.csv", Buffer.from("a,b\n1,2\n"), "up-doc")).attachment;
	a.send({ type: "send", text: "mirá esto", requestId: "r-att", attachments: [img.id, doc.id] });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	const prompt = engine.requests.find((r) => r.type === "prompt");
	const stored = (att) => path.join(uploadsDir(engine), att.id, att.name);
	assert.ok(prompt.message.startsWith("mirá esto\n\n<attachments>\nThe user attached these files, saved in your workspace."), prompt.message);
	assert.ok(prompt.message.includes(JSON.stringify({ name: "datos.csv", size: 8, type: "application/octet-stream", path: stored(doc) })), prompt.message);
	assert.ok(prompt.message.includes(`"image":"attached to this message"`), prompt.message);
	assert.deepEqual(prompt.images, [{ type: "image", mimeType: "image/png", data: PNG_BYTES.toString("base64") }]);
	// the engine records the composed prompt: every client sees the user's text and the chips
	engine.emit("event", { type: "agent_start" });
	recordUser(engine, [{ type: "text", text: prompt.message }, { type: "image", data: "x", mimeType: "image/png" }]);
	const own = await a.wait((f) => f.type === "user_message");
	const theirs = await b.wait((f) => f.type === "user_message");
	const chips = [{ name: "foto.png", size: PNG_BYTES.length, mime: "image/png" }, { name: "datos.csv", size: 8, mime: "application/octet-stream" }];
	assert.deepEqual({ ...own, seq: 0 }, { type: "user_message", messageId: "s1-1", text: "mirá esto", attachments: chips, requestId: "r-att", seq: 0 });
	assert.deepEqual(theirs.attachments, chips);
	persist(engine, "user", prompt.message);
	persist(engine, "assistant", "listo");
	engine.emit("event", { type: "agent_settled" });
	b.send({ type: "get_history" });
	const page = await b.wait((f) => f.type === "history");
	assert.deepEqual(page.messages.find((m) => m.id === "s1-1"), { id: "s1-1", role: "user", text: "mirá esto", activities: [], attachments: chips });
	// a ref is used once: the files stay for the agent, a second send naming them is refused
	assert.ok(fs.existsSync(stored(doc)));
	a.send({ type: "send", text: "otra vez", requestId: "r-again", attachments: [doc.id] });
	const again = await a.wait((f) => f.type === "error" && f.requestId === "r-again");
	assert.equal(again.code, "attachment_not_found");
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1);
});

test("attachments: a model without vision gets the path only; files-only messages have empty text", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	engine.stateData = { model: { id: "text-only", input: ["text"] } };
	const a = await login(t, endpoint);
	const img = (await upload(a, "foto.png", PNG_BYTES, "up-img")).attachment;
	a.send({ type: "send", text: "", requestId: "r-only", attachments: [img.id] });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	const prompt = engine.requests.find((r) => r.type === "prompt");
	assert.equal(prompt.images, undefined);
	assert.ok(prompt.message.startsWith("<attachments>\n"), prompt.message);
	assert.ok(prompt.message.includes("the current model cannot see images"));
});

test("attachments: another client's ref, an unknown ref and a malformed ref never reach the engine", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const doc = (await upload(a, "nota.txt", Buffer.from("x"), "up-a")).attachment;
	b.send({ type: "send", text: "robo", requestId: "r-b", attachments: [doc.id] });
	assert.equal((await b.wait((f) => f.type === "error" && f.requestId === "r-b")).code, "attachment_not_found");
	b.send({ type: "send", text: "inventado", requestId: "r-c", attachments: ["a-0000000000000000"] });
	assert.equal((await b.wait((f) => f.type === "error" && f.requestId === "r-c")).code, "attachment_not_found");
	b.send({ type: "send", text: "ruta", attachments: [path.join(uploadsDir(engine), doc.id, "nota.txt")] });
	await b.wait((f) => f.type === "error" && f.code === "bad_request");
	await sleep(30);
	assert.equal(engine.requests.some((r) => r.type === "prompt"), false);
	// the refused request is not spent: its sender may retry it
	a.send({ type: "send", text: "mío", requestId: "r-b", attachments: [doc.id] });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
});

test("attachments: per-client quota and size are enforced daemon-side; one error per refused upload", async (t) => {
	const { endpoint, server } = await chatOnFile(t);
	server.uploads.limits = { fileBytes: 10, messageBytes: 12, files: 2 };
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	assert.equal((await upload(a, "grande.bin", Buffer.alloc(11), "up-big")).code, "file_too_large");
	await sleep(30);
	assert.equal(a.frames.filter((f) => f.requestId === "up-big").length, 1, "the later chunks of a refused upload are ignored, not answered");
	assert.equal((await upload(a, "1.bin", Buffer.alloc(8), "up-1")).type, "uploaded");
	assert.equal((await upload(a, "2.bin", Buffer.alloc(5), "up-2")).code, "message_too_large");
	assert.equal((await upload(a, "2.bin", Buffer.alloc(4), "up-3")).type, "uploaded");
	assert.equal((await upload(a, "3.bin", Buffer.alloc(1), "up-4")).code, "too_many_files");
	assert.equal((await upload(b, "1.bin", Buffer.alloc(8), "up-b")).type, "uploaded", "every client has its own quota");
});

test("attachments: removed before sending, or its client gone: the unsent file is deleted; a sent one stays", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const kept = (await upload(a, "enviado.txt", Buffer.from("1"), "up-1")).attachment;
	const removed = (await upload(a, "quitado.txt", Buffer.from("2"), "up-2")).attachment;
	const left = (await upload(a, "olvidado.txt", Buffer.from("3"), "up-3")).attachment;
	a.send({ type: "upload_discard", id: removed.id });
	await waitFor(() => !fs.existsSync(path.join(uploadsDir(engine), removed.id)));
	a.send({ type: "send", text: "va", requestId: "r-1", attachments: [kept.id] });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	a.socket.destroy();
	await waitFor(() => !fs.existsSync(path.join(uploadsDir(engine), left.id)));
	assert.ok(fs.existsSync(path.join(uploadsDir(engine), kept.id, "enviado.txt")), "a sent file stays for the agent");
});

test("attachments: upload chunks have their own frame budget (a large file never trips the 240/min limit)", async (t) => {
	const { endpoint } = await setup(t, { limits: { framesPerMinute: 5, uploadFramesPerMinute: 400 } });
	const a = await login(t, endpoint);
	const done = await upload(a, "largo.bin", Buffer.alloc(CHUNK * 300, 7), "up-long");
	assert.equal(done.type, "uploaded");
	assert.equal(a.closed, false);
	const { endpoint: e2 } = await setup(t, { limits: { uploadFramesPerMinute: 3 } });
	const flood = await login(t, e2);
	upload(flood, "x.bin", Buffer.alloc(CHUNK * 10), "up-flood").catch(() => {});
	await waitFor(() => flood.closed);
});

test("attachments: a prompt held during a rotation carries its files and spends them when delivered", async (t) => {
	const { endpoint, engine } = await chatOnFile(t);
	const a = await login(t, endpoint);
	const doc = (await upload(a, "nota.txt", Buffer.from("x"), "up-1")).attachment;
	engine.sessionChange = { switching: true };
	a.send({ type: "send", text: "después", requestId: "r-held", attachments: [doc.id] });
	await sleep(30);
	assert.equal(engine.requests.some((r) => r.type === "prompt"), false);
	engine.sessionChange = undefined;
	engine.emit("status");
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
	assert.ok(engine.requests.find((r) => r.type === "prompt").message.includes(`"name":"nota.txt"`));
	a.send({ type: "send", text: "repetido", requestId: "r-2", attachments: [doc.id] });
	assert.equal((await a.wait((f) => f.requestId === "r-2" && f.type === "error")).code, "attachment_not_found");
});
